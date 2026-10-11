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

const decodeMatches = Schema.decodeUnknownSync(Schema.Array(Match));
const decodeMatch = Schema.decodeUnknownSync(Match);

export const fetchMatches = async (status: MatchStatus) =>
  decodeMatches(await api(`/matches?status=${status}`));

export const setMatchStatus = async (id: string, status: MatchStatus) =>
  decodeMatch(await api(`/matches/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }));
