import type { Metadata } from "next";
import { AnalyzeView } from "@/components/analyze-view";

export const metadata: Metadata = { title: "Analyze | Job Matcher" };

export default function AnalyzePage() {
  return <AnalyzeView />;
}
