import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { QueueModule } from "../queue/queue.module";
import { RedisModule } from "../redis/redis.module";
import { RunsProcessor } from "../runs/runs.processor";
import { EffectRuntime } from "./effect-runtime";

@Module({
  imports: [PrismaModule, RedisModule, QueueModule],
  providers: [EffectRuntime, RunsProcessor],
})
export class WorkerModule {}
