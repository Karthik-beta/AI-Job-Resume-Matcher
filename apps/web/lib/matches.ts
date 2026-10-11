import { MatchStatus } from "@job-matcher/shared";
import { Schema } from "effect";
import { api } from "@/lib/api";

const Match = Schema.Struct({
  id: Schema.String,
  jobUrl: Schema.String,
  title: Schema.String,
  company: Schema.String,
  locations: Schema.Array(Schema.String),
  reason: Schema.String,
  status: MatchStatus,
  matchedAt: Schema.String,
});
export type Match = typeof Match.Type;

const decodeMatchesPage = Schema.decodeUnknownSync(
  Schema.Struct({ items: Schema.Array(Match), nextCursor: Schema.NullOr(Schema.String) }),
);
const decodeMatch = Schema.decodeUnknownSync(Match);

export const fetchMatches = async (status: MatchStatus, cursor: string | null) =>
  decodeMatchesPage(
    await api(`/matches?${new URLSearchParams({ status, ...(cursor && { cursor }) })}`),
  );

export const setMatchStatus = async (id: string, status: MatchStatus) =>
  decodeMatch(await api(`/matches/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }));
