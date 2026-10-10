"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { JobSources } from "@/components/job-sources";
import { PreferencesForm } from "@/components/preferences-form";
import { authClient } from "@/lib/auth-client";

export function SettingsView() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && !session) router.replace("/sign-in");
  }, [isPending, session, router]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 sm:px-8">
      <header className="py-6">
        <Link href="/" className="text-lg font-bold tracking-tight">
          Job Matcher
        </Link>
      </header>
      <main className="flex max-w-2xl flex-col gap-16 pt-10 pb-24 lg:pt-16">
        <h1 className="text-4xl font-extrabold tracking-[-0.03em]">Settings</h1>
        {session && (
          <>
            <JobSources />
            <PreferencesForm />
          </>
        )}
      </main>
    </div>
  );
}
