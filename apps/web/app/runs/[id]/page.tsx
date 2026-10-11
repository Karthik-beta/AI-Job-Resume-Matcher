import type { Metadata } from "next";
import { RunDetailsView } from "@/components/run-details-view";

export const metadata: Metadata = { title: "Run details | Job Matcher" };

export default async function RunDetailsPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  return <RunDetailsView id={id} />;
}
