"use client";

import { AppPage } from "@/components/app-page";
import { ClearCache } from "@/components/clear-cache";
import { JobSources } from "@/components/job-sources";
import { PreferencesForm } from "@/components/preferences-form";

export function SettingsView() {
  return (
    <AppPage title="Settings" className="gap-16">
      <JobSources />
      <PreferencesForm />
      <ClearCache />
    </AppPage>
  );
}
