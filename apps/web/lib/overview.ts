import { Overview } from "@job-matcher/shared";
import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { api } from "@/lib/api";

export type { Overview };

export const overviewKey = ["overview"] as const;

const decodeOverview = Schema.decodeUnknownSync(Overview);

export const fetchOverview = async () => decodeOverview(await api("/overview"));

// Refreshed every minute so scheduled runs and the next check time stay current.
export const useOverview = () =>
  useQuery({ queryKey: overviewKey, queryFn: fetchOverview, refetchInterval: 60_000 });
