import { defaultSettings, type UpdateSettings } from "@job-matcher/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { runsQueue, type ScheduledJob, scheduledJob, schedulerId } from "../runs/runs.queue";

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(runsQueue) private readonly queue: Queue<ScheduledJob>,
  ) {}

  async get(userId: string): Promise<UpdateSettings> {
    const row = await this.prisma.settings.findUnique({ where: { userId } });
    if (!row) return defaultSettings;
    const { userId: _, ...settings } = row;
    return settings;
  }

  async update(userId: string, settings: UpdateSettings): Promise<UpdateSettings> {
    const data = { ...settings, locations: [...settings.locations] };
    const { userId: _, ...saved } = await this.prisma.settings.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    await this.syncSchedule(userId, saved.scheduleMinutes);
    return saved;
  }

  private async syncSchedule(userId: string, minutes: number | null) {
    if (minutes === null) {
      await this.queue.removeJobScheduler(schedulerId(userId));
      return;
    }
    await this.queue.upsertJobScheduler(
      schedulerId(userId),
      { every: minutes * 60_000 },
      { name: scheduledJob, data: { userId }, opts: { attempts: 1 } },
    );
  }
}
