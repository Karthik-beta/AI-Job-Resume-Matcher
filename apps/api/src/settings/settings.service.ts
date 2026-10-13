import { defaultSettings, type UpdateSettings } from "@job-matcher/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { Settings } from "../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { type RunJob, runsQueue, type ScheduledJob } from "../runs/runs.queue";
import { syncSchedule } from "../runs/schedule";

// The columns a settings save writes. Settings rows are created lazily, by the first save or by
// an onboarding flag (see OnboardingService), and both create them from these.
export const settingsData = (settings: UpdateSettings) => ({
  ...settings,
  locations: [...settings.locations],
  titleInclude: [...settings.titleInclude],
  titleExclude: [...settings.titleExclude],
});

// The settings form's fields: the row without its key and the onboarding flags.
const settingsOf = (row: Settings): UpdateSettings => {
  const { userId: _, onboardingCompletedAt: __, onboardingDismissedAt: ___, ...settings } = row;
  return settings;
};

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(runsQueue) private readonly queue: Queue<RunJob | ScheduledJob>,
  ) {}

  async get(userId: string): Promise<UpdateSettings> {
    const row = await this.prisma.settings.findUnique({ where: { userId } });
    return row ? settingsOf(row) : defaultSettings;
  }

  async update(userId: string, settings: UpdateSettings): Promise<UpdateSettings> {
    const data = settingsData(settings);
    const saved = settingsOf(
      await this.prisma.settings.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      }),
    );
    await syncSchedule(this.queue, userId, saved.scheduleMinutes);
    return saved;
  }
}
