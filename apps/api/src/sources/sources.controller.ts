import { CreateJobSource } from "@job-matcher/shared";
import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { SchemaPipe } from "../common/schema.pipe";
import { SourcesService } from "./sources.service";

@Controller("sources")
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Get()
  list(@Session() session: UserSession) {
    return this.sources.list(session.user.id);
  }

  @Post()
  create(
    @Session() session: UserSession,
    @Body(new SchemaPipe(CreateJobSource)) body: CreateJobSource,
  ) {
    return this.sources.create(session.user.id, body.url);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Session() session: UserSession, @Param("id") id: string) {
    return this.sources.remove(session.user.id, id);
  }
}
