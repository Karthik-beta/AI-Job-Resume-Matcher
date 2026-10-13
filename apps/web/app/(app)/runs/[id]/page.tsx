import type { Metadata } from "next";
import { RunDetailsView } from "@/components/run-details-view";

export const metadata: Metadata = { title: "Run details | Job Matcher" };

// The run details read the URL inside their own Suspense boundary, so the page shell, title
// included, can be prerendered.
export default function RunDetailsPage() {
  return <RunDetailsView />;
}
