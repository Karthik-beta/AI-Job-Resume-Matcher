import { defaultSettings, type Onboarding } from "@job-matcher/shared";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { settingsData } from "../settings/settings.service";
import { onboardingOf } from "./onboarding";

type Flag = "onboardingCompletedAt" | "onboardingDismissedAt";

@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<Onboarding> {
    const [settings, sourceCount, run] = await Promise.all([
      this.prisma.settings.findUnique({ where: { userId } }),
      this.prisma.jobSource.count({ where: { userId } }),
      this.prisma.run.findFirst({ where: { userId }, select: { id: true } }),
    ]);
    return onboardingOf(settings, sourceCount, run !== null);
  }

  complete(userId: string) {
    return this.mark(userId, "onboardingCompletedAt");
  }

  dismiss(userId: string) {
    return this.mark(userId, "onboardingDismissedAt");
  }

  // Shows the checklist again. Without a settings row it was never hidden.
  async restore(userId: string) {
    await this.prisma.settings.updateMany({
      where: { userId },
      data: { onboardingDismissedAt: null },
    });
    return this.get(userId);
  }

  // Sets a flag once: repeating the request keeps the first time. Settings rows are created
  // lazily, so a user who has saved nothing gets the row a first save of the defaults would make.
  // The insert skips an existing row (ON CONFLICT DO NOTHING), so concurrent first calls for the
  // same user cannot fail on the primary key.
  private async mark(userId: string, flag: Flag) {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.settings.createMany({
        data: [{ userId, ...settingsData(defaultSettings), [flag]: now }],
        skipDuplicates: true,
      }),
      this.prisma.settings.updateMany({ where: { userId, [flag]: null }, data: { [flag]: now } }),
    ]);
    return this.get(userId);
  }
}
