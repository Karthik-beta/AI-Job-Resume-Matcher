import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { Redis } from "ioredis";
import { config } from "../config";

@Injectable()
export class RedisService extends Redis implements OnApplicationShutdown {
  constructor() {
    // BullMQ workers need commands to wait for a reconnect rather than fail.
    super(config.REDIS_URL, { maxRetriesPerRequest: null });
  }

  async onApplicationShutdown() {
    await this.quit();
  }
}
