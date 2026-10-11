import { MatchesQuery, UpdateMatch } from "@job-matcher/shared";
import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { Session, type UserSession } from "@thallesp/nestjs-better-auth";
import { SchemaPipe } from "../common/schema.pipe";
import { MatchesService } from "./matches.service";

@Controller("matches")
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  @Get()
  list(@Session() session: UserSession, @Query(new SchemaPipe(MatchesQuery)) query: MatchesQuery) {
    return this.matches.list(session.user.id, query.status, query.cursor);
  }

  @Patch(":id")
  update(
    @Session() session: UserSession,
    @Param("id") id: string,
    @Body(new SchemaPipe(UpdateMatch)) body: UpdateMatch,
  ) {
    return this.matches.setStatus(session.user.id, id, body.status);
  }
}
