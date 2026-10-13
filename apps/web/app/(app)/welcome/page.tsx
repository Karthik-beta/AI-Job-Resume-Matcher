import type { Metadata } from "next";
import { Suspense } from "react";
import { WelcomeView } from "@/components/welcome-view";

export const metadata: Metadata = { title: "Get set up | Job Matcher" };

// The step is read from the URL on the client, inside Suspense, so the page shell can be
// prerendered.
export default function WelcomePage() {
  return (
    <Suspense>
      <WelcomeView />
    </Suspense>
  );
}
