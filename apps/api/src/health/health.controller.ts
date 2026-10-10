import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

const redisTimeoutMs = 2_000;

// Redis commands wait for a reconnect instead of failing, so the ping needs its own deadline.
const withTimeout = <T>(promise: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

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
}
