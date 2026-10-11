import { Controller, Delete } from "@nestjs/common";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { CacheService } from "./cache.service";

@Controller("cache")
export class CacheController {
  constructor(private readonly cache: CacheService) {}

  @Delete()
  clear(@Session() session: UserSession) {
    return this.cache.clear(session.user.id);
  }
}
