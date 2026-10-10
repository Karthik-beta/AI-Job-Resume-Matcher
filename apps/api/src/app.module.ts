import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { HealthController } from "./health/health.controller";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { RedisService } from "./redis/redis.service";
import { RunsController } from "./runs/runs.controller";
import { runsQueue } from "./runs/runs.queue";
import { RunsService } from "./runs/runs.service";
import { SettingsController } from "./settings/settings.controller";
import { SettingsService } from "./settings/settings.service";
import { SourcesController } from "./sources/sources.controller";
import { SourcesService } from "./sources/sources.service";

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    AuthModule,
    BullModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({ connection: redis }),
    }),
    BullModule.registerQueue({ name: runsQueue }),
  ],
  controllers: [HealthController, SourcesController, SettingsController, RunsController],
  providers: [SourcesService, SettingsService, RunsService],
})
export class AppModule {}
