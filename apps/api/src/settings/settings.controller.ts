import { UpdateSettings } from "@job-matcher/shared";
import { Body, Controller, Get, Put } from "@nestjs/common";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { SchemaPipe } from "../common/schema.pipe";
import { SettingsService } from "./settings.service";

@Controller("settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(@Session() session: UserSession) {
    return this.settings.get(session.user.id);
  }

  @Put()
  update(
    @Session() session: UserSession,
    @Body(new SchemaPipe(UpdateSettings)) body: UpdateSettings,
  ) {
    return this.settings.update(session.user.id, body);
  }
}
