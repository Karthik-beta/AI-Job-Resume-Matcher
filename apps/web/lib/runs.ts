import { UpdateSettings } from "@job-matcher/shared";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { ApiError, api } from "@/lib/api";

const RunStatus = Schema.Literals(["QUEUED", "RUNNING", "COMPLETED", "STOPPED", "FAILED"]);
export type RunStatus = typeof RunStatus.Type;

const Run = Schema.Struct({
  id: Schema.String,
  status: RunStatus,
  sourceIds: Schema.Array(Schema.String),
  found: Schema.Number,
  eligible: Schema.Number,
  checked: Schema.Number,
  failed: Schema.Number,
  stopReason: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type Run = typeof Run.Type;

const JobResult = Schema.Struct({
  id: Schema.String,
  jobUrl: Schema.String,
  title: Schema.String,
  company: Schema.String,
  isMatch: Schema.NullOr(Schema.Boolean),
  reason: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  matchSaved: Schema.Boolean,
});
export type JobResult = typeof JobResult.Type;

const RunDetail = Schema.Struct({ ...Run.fields, results: Schema.Array(JobResult) });
export type RunDetail = typeof RunDetail.Type;

const Source = Schema.Struct({ id: Schema.String, url: Schema.String });
export type Source = typeof Source.Type;

const decodeRun = Schema.decodeUnknownSync(Run);
const decodeRuns = Schema.decodeUnknownSync(Schema.Array(Run));
const decodeRunDetail = Schema.decodeUnknownSync(RunDetail);
const decodeSources = Schema.decodeUnknownSync(Schema.Array(Source));
const decodeSettings = Schema.decodeUnknownSync(UpdateSettings);

export const isActive = (status: RunStatus) => status === "QUEUED" || status === "RUNNING";

export const fetchRuns = async () => decodeRuns(await api("/runs"));
export const fetchRun = async (id: string) => decodeRunDetail(await api(`/runs/${id}`));
export const fetchSources = async () => decodeSources(await api("/sources"));
export const fetchSettings = async () => decodeSettings(await api("/settings"));

export const startRun = async (sourceIds: readonly string[]) =>
  decodeRun(await api("/runs", { method: "POST", body: JSON.stringify({ sourceIds }) }));

export const retrySave = (runId: string, resultId: string) =>
  api(`/runs/${runId}/results/${resultId}/save`, { method: "POST" });

const pollMs = 2_000;

// Polls while the run is queued or running. A missing run is not retried.
export const useRun = (id: string | undefined) =>
  useQuery({
    queryKey: ["runs", id],
    queryFn: id ? () => fetchRun(id) : skipToken,
    refetchInterval: (query) =>
      query.state.data && !isActive(query.state.data.status) ? false : pollMs,
    retry: (failures, error) =>
      !(error instanceof ApiError && error.status === 404) && failures < 3,
  });
