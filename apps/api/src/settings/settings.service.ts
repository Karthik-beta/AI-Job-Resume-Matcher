import { defaultSettings, type UpdateSettings } from "@job-matcher/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { type RunJob, runsQueue, type ScheduledJob } from "../runs/runs.queue";
import { syncSchedule } from "../runs/schedule";

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(runsQueue) private readonly queue: Queue<RunJob | ScheduledJob>,
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
    await syncSchedule(this.queue, userId, saved.scheduleMinutes);
    return saved;
  }
}
