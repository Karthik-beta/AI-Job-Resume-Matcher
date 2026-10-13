"use client";

import { cn } from "cn";
import type { ReactNode } from "react";
import { useSessionGate } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// The page body inside the app layout. The layout guards the session; until it is known, the
// page shows its title over a skeleton (or a retry, if checking failed) and never renders its
// content.
export function AppPage({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  const gate = useSessionGate();

  return (
    <main className={cn("flex max-w-2xl flex-col gap-10 pt-10 pb-24 lg:pt-16", className)}>
      <h1 className="text-4xl font-extrabold tracking-[-0.03em]">{title}</h1>
      {gate.status === "signed-in" ? (
        children
      ) : gate.status === "failed" ? (
        <div className="flex flex-col items-start gap-4 border-y py-8">
          <p className="text-destructive">Couldn't reach the server.</p>
          <Button variant="outline" onClick={gate.retry}>
            Try again
          </Button>
        </div>
      ) : (
        <PageSkeleton />
      )}
    </main>
  );
}

function PageSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
