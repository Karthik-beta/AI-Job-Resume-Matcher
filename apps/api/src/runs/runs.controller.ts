import { StartRun } from "@job-matcher/shared";
import { Body, Controller, Post } from "@nestjs/common";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { SchemaPipe } from "../common/schema.pipe";
import { RunsService } from "./runs.service";

@Controller("runs")
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post()
  start(@Session() session: UserSession, @Body(new SchemaPipe(StartRun)) body: StartRun) {
    return this.runs.start(session.user.id, body.sourceIds);
  }
}
