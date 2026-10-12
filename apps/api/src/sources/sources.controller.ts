import { CreateJobSource, CreateSearchSource, UpdateJobSource } from "@job-matcher/shared";
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
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

  @Post("search")
  createSearch(
    @Session() session: UserSession,
    @Body(new SchemaPipe(CreateSearchSource)) body: CreateSearchSource,
  ) {
    return this.sources.createSearch(session.user.id, body.query);
  }

  @Patch(":id")
  update(
    @Session() session: UserSession,
    @Param("id") id: string,
    @Body(new SchemaPipe(UpdateJobSource)) body: UpdateJobSource,
  ) {
    return this.sources.update(session.user.id, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Session() session: UserSession, @Param("id") id: string) {
    return this.sources.remove(session.user.id, id);
  }
}
