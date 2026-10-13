import type { Metadata } from "next";
import { Suspense } from "react";
import { RunDetailsView } from "@/components/run-details-view";

export const metadata: Metadata = { title: "Run details | Job Matcher" };

// The run id is read on the client, inside Suspense, so the page shell can be prerendered.
export default function RunDetailsPage() {
  return (
    <Suspense>
      <RunDetailsView />
    </Suspense>
  );
}
