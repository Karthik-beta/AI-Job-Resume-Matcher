import { InjectQueue } from "@nestjs/bullmq";
import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { Queue } from "bullmq";
import { withTimeout } from "../common/timeout";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { runsQueue } from "../runs/runs.queue";

const redisTimeoutMs = 2_000;

const upOrDown = (promise: Promise<unknown>) =>
  promise.then(
    () => "up" as const,
    () => "down" as const,
  );

@AllowAnonymous()
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @InjectQueue(runsQueue) private readonly queue: Queue,
  ) {}

  @Get()
  async check() {
    const [database, redis] = await Promise.all([
      upOrDown(this.prisma.$queryRaw`SELECT 1`),
      upOrDown(withTimeout(this.redis.ping(), redisTimeoutMs)),
    ]);
    const status = { database, redis };
    if (database === "down" || redis === "down") throw new ServiceUnavailableException(status);
    return status;
  }

  // Up once a run worker is connected to the queue. The e2e setup waits on this.
  @Get("worker")
  async worker() {
    const workers = await withTimeout(this.queue.getWorkers(), redisTimeoutMs).catch(() => []);
    if (workers.length === 0) throw new ServiceUnavailableException({ worker: "down" });
    return { worker: "up" };
  }
}
