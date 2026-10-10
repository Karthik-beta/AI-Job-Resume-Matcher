import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";
import { runsQueue } from "../runs/runs.queue";

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({ connection: redis }),
    }),
    BullModule.registerQueue({ name: runsQueue }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
