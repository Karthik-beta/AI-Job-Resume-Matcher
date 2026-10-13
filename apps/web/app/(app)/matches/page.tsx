import type { Metadata } from "next";
import { MatchesView } from "@/components/matches-view";

export const metadata: Metadata = { title: "Matches | Job Matcher" };

export default function MatchesPage() {
  return <MatchesView />;
}
