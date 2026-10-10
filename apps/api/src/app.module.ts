import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { HealthController } from "./health/health.controller";
import { PrismaModule } from "./prisma/prisma.module";
import { QueueModule } from "./queue/queue.module";
import { RedisModule } from "./redis/redis.module";
import { RunsController } from "./runs/runs.controller";
import { RunsService } from "./runs/runs.service";
import { SettingsController } from "./settings/settings.controller";
import { SettingsService } from "./settings/settings.service";
import { SourcesController } from "./sources/sources.controller";
import { SourcesService } from "./sources/sources.service";

@Module({
  imports: [PrismaModule, RedisModule, AuthModule, QueueModule],
  controllers: [HealthController, SourcesController, SettingsController, RunsController],
  providers: [SourcesService, SettingsService, RunsService],
})
export class AppModule {}
