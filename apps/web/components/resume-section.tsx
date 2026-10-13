"use client";

import type { UpdateSettings } from "@job-matcher/shared";
import {
  optionalText,
  SectionForm,
  SettingField,
  SettingsLoader,
  SettingsSection,
  useSectionSave,
} from "@/components/settings-section";
import { Input } from "@/components/ui/input";

const fields = ["resumeUrl"] as const;

export function ResumeSection({
  onSaved,
  className,
}: {
  onSaved?: ((settings: UpdateSettings) => void) | undefined;
  className?: string | undefined;
}) {
  return (
    <SettingsSection
      id="resume"
      title="Resume"
      description="Every job is checked against this resume. Use a public link to a PDF (Google Drive and Dropbox share links work) or to a page such as a Google Doc."
      className={className}
    >
      <SettingsLoader>
        {({ settings }) => <ResumeForm settings={settings} onSaved={onSaved} />}
      </SettingsLoader>
    </SettingsSection>
  );
}

function ResumeForm({
  settings,
  onSaved,
}: {
  settings: UpdateSettings;
  onSaved: ((settings: UpdateSettings) => void) | undefined;
}) {
  const { errors, formError, pending, save } = useSectionSave({
    fields,
    savedMessage: "Resume saved",
    onSaved,
  });

  return (
    <SectionForm
      onSubmit={(data) => void save({ resumeUrl: optionalText(data, "resumeUrl") })}
      formError={formError}
      pending={pending}
      submitLabel="Save resume"
    >
      <SettingField name="resumeUrl" label="Resume URL" error={errors["resumeUrl"]}>
        <Input
          id="resumeUrl"
          name="resumeUrl"
          defaultValue={settings.resumeUrl ?? ""}
          placeholder="https://example.com/resume.pdf"
        />
      </SettingField>
    </SectionForm>
  );
}
