import { defaultSettings, type UpdateSettings } from "@job-matcher/shared";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

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
    return saved;
  }
}
