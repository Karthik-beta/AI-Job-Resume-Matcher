import type { Overview } from "@job-matcher/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { withTimeout } from "../common/timeout";
import { hasPreferences, onboardingOf } from "../onboarding/onboarding";
import { PrismaService } from "../prisma/prisma.service";
import { type RunJob, runsQueue, type ScheduledJob, schedulerId } from "../runs/runs.queue";

// Redis commands wait for a reconnect (see RedisService), so the scheduler lookup is cut short
// rather than holding up the home page while Redis is down.
const schedulerLookupMs = 1_000;

// Used when the scheduler cannot be read: the user's last SCHEDULED run started on a tick, and
// later ticks follow every `everyMs`. A tick skipped while a run was active leaves no run, so the
// estimate steps forward by whole intervals to the first tick after `now`. Null before the first
// scheduled run, when nothing places the ticks.
export const estimateNextRun = (lastScheduledAt: Date | null, everyMs: number, now: Date) => {
  if (!lastScheduledAt) return null;
  const elapsed = now.getTime() - lastScheduledAt.getTime();
  const intervals = Math.max(1, Math.floor(elapsed / everyMs) + 1);
  return new Date(lastScheduledAt.getTime() + intervals * everyMs);
};

@Injectable()
export class OverviewService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(runsQueue) private readonly queue: Queue<RunJob | ScheduledJob>,
  ) {}

  async get(userId: string, now = new Date()): Promise<Overview> {
    const [settings, sourceCount, latestRun, activeRun, pendingMatches] = await Promise.all([
      this.prisma.settings.findUnique({ where: { userId } }),
      this.prisma.jobSource.count({ where: { userId } }),
      this.prisma.run.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          createdAt: true,
          finishedAt: true,
          _count: { select: { results: { where: { isMatch: true } } } },
        },
      }),
      this.prisma.run.findFirst({
        where: { userId, status: { in: ["QUEUED", "RUNNING"] } },
        // Normally at most one; if a tick ever races a manual start, report the newest.
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true },
      }),
      this.prisma.match.count({ where: { userId, status: "PENDING" } }),
    ]);
    const scheduleMinutes = settings?.scheduleMinutes ?? null;
    const hasResume = Boolean(settings?.resumeUrl);
    // A tick starts no run until there is a resume and a source (see createScheduledRun), so
    // there is no next check to promise before then.
    const schedulesRuns = scheduleMinutes !== null && hasResume && sourceCount > 0;

    return {
      setup: {
        hasResume,
        sourceCount,
        hasPreferences: hasPreferences(settings),
        hasRun: latestRun !== null,
      },
      latestRun: latestRun && {
        id: latestRun.id,
        status: latestRun.status,
        createdAt: latestRun.createdAt.toISOString(),
        finishedAt: latestRun.finishedAt?.toISOString() ?? null,
        matchCount: latestRun._count.results,
      },
      activeRun: activeRun && {
        id: activeRun.id,
        status: activeRun.status === "RUNNING" ? "RUNNING" : "QUEUED",
      },
      pendingMatches,
      nextScheduledRunAt: schedulesRuns
        ? ((await this.nextScheduledRun(userId, scheduleMinutes * 60_000, now))?.toISOString() ??
          null)
        : null,
      onboarding: onboardingOf(settings, sourceCount, latestRun !== null),
    };
  }

  // The schedule is a BullMQ job scheduler (see syncSchedule), which holds the time of its next
  // tick. A tick starts a SCHEDULED run unless a run is active or setup is incomplete.
  private async nextScheduledRun(userId: string, everyMs: number, now: Date) {
    try {
      const scheduler = await withTimeout(
        this.queue.getJobScheduler(schedulerId(userId)),
        schedulerLookupMs,
      );
      if (scheduler?.next !== undefined) return new Date(scheduler.next);
    } catch {
      // Estimated from the runs below.
    }
    const last = await this.prisma.run.findFirst({
      where: { userId, trigger: "SCHEDULED" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return estimateNextRun(last?.createdAt ?? null, everyMs, now);
  }
}
