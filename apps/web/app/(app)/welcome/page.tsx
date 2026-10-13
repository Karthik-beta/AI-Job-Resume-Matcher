import type { Metadata } from "next";
import { WelcomeView } from "@/components/welcome-view";

export const metadata: Metadata = { title: "Get set up | Job Matcher" };

// The wizard reads its step from the URL inside its own Suspense boundary, so the page shell,
// title included, can be prerendered.
export default function WelcomePage() {
  return <WelcomeView />;
}
