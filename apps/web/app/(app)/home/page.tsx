import type { Metadata } from "next";
import Link from "next/link";
import { AppPage } from "@/components/app-page";

export const metadata: Metadata = { title: "Home | Job Matcher" };

export default function HomePage() {
  return (
    <AppPage title="Home">
      <p className="leading-relaxed text-muted-foreground">
        Start a run from{" "}
        <Link href="/analyze" className="text-foreground underline underline-offset-4">
          Analyze
        </Link>
        , or review the listings you kept in{" "}
        <Link href="/matches" className="text-foreground underline underline-offset-4">
          Matches
        </Link>
        .
      </p>
    </AppPage>
  );
}
