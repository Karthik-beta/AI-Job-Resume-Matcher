"use client";

import { ClearCache } from "@/components/clear-cache";
import { JobSources } from "@/components/job-sources";
import { PreferencesForm } from "@/components/preferences-form";
import { SignedInPage } from "@/components/signed-in-page";

export function SettingsView() {
  return (
    <SignedInPage title="Settings" className="gap-16">
      <JobSources />
      <PreferencesForm />
      <ClearCache />
    </SignedInPage>
  );
}
