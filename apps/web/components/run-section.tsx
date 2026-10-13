"use client";

import type { UpdateSettings } from "@job-matcher/shared";
import { useState } from "react";
import {
  SectionForm,
  SettingField,
  SettingsLoader,
  SettingsSection,
  text,
  useSectionSave,
} from "@/components/settings-section";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const fields = ["maxJobsPerRun", "triageEnabled"] as const;

export function RunSection({
  onSaved,
  className,
}: {
  onSaved?: ((settings: UpdateSettings) => void) | undefined;
  className?: string | undefined;
}) {
  return (
    <SettingsSection
      id="runs"
      title="Runs"
      description="How much each run reads. Fewer jobs per run keeps runs quick and uses fewer credits."
      className={className}
    >
      <SettingsLoader>
        {({ settings }) => <RunForm settings={settings} onSaved={onSaved} />}
      </SettingsLoader>
    </SettingsSection>
  );
}

function RunForm({
  settings,
  onSaved,
}: {
  settings: UpdateSettings;
  onSaved: ((settings: UpdateSettings) => void) | undefined;
}) {
  const [triageEnabled, setTriageEnabled] = useState(settings.triageEnabled);
  const { errors, formError, pending, save } = useSectionSave({
    fields,
    savedMessage: "Run settings saved",
    onSaved,
  });

  return (
    <SectionForm
      onSubmit={(data) =>
        void save({ maxJobsPerRun: Number(text(data, "maxJobsPerRun")), triageEnabled })
      }
      formError={formError}
      pending={pending}
      submitLabel="Save run settings"
    >
      <FieldGroup>
        <SettingField
          name="maxJobsPerRun"
          label="Jobs to check per run"
          error={errors["maxJobsPerRun"]}
        >
          <Input
            id="maxJobsPerRun"
            name="maxJobsPerRun"
            type="number"
            defaultValue={settings.maxJobsPerRun}
          />
        </SettingField>
        <Field orientation="horizontal">
          <Switch id="triageEnabled" checked={triageEnabled} onCheckedChange={setTriageEnabled} />
          <div className="flex flex-col gap-1">
            <FieldLabel htmlFor="triageEnabled">Rank job titles before checking jobs</FieldLabel>
            <FieldDescription>
              One quick model request ranks every title against your resume, and only likely fits
              are read and checked. Turn off to check every eligible job.
            </FieldDescription>
          </div>
        </Field>
      </FieldGroup>
    </SectionForm>
  );
}
