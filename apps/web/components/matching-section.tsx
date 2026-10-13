"use client";

import type { UpdateSettings } from "@job-matcher/shared";
import { useState } from "react";
import {
  list,
  optionalNumber,
  SectionForm,
  SettingField,
  SettingsLoader,
  SettingsSection,
  text,
  useSectionSave,
} from "@/components/settings-section";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const fields = [
  "experienceYears",
  "experienceMonths",
  "targetMinYears",
  "targetMaxYears",
  "locations",
  "titleInclude",
  "titleExclude",
  "includeUnknown",
] as const;

export function MatchingSection({
  onSaved,
  className,
}: {
  onSaved?: ((settings: UpdateSettings) => void) | undefined;
  className?: string | undefined;
}) {
  return (
    <SettingsSection
      id="matching"
      title="Matching"
      description="Listings outside your experience, cities or job titles are skipped before they are read, so runs only spend time on jobs that could fit."
      className={className}
    >
      <SettingsLoader>
        {({ settings }) => <MatchingForm settings={settings} onSaved={onSaved} />}
      </SettingsLoader>
    </SettingsSection>
  );
}

function MatchingForm({
  settings,
  onSaved,
}: {
  settings: UpdateSettings;
  onSaved: ((settings: UpdateSettings) => void) | undefined;
}) {
  const [includeUnknown, setIncludeUnknown] = useState(settings.includeUnknown);
  const { errors, formError, pending, save } = useSectionSave({
    fields,
    savedMessage: "Matching preferences saved",
    onSaved,
  });

  function submit(data: FormData) {
    void save({
      experienceYears: Number(text(data, "experienceYears")),
      experienceMonths: Number(text(data, "experienceMonths")),
      targetMinYears: optionalNumber(data, "targetMinYears"),
      targetMaxYears: optionalNumber(data, "targetMaxYears"),
      locations: list(data, "locations"),
      includeUnknown,
      titleInclude: list(data, "titleInclude"),
      titleExclude: list(data, "titleExclude"),
    });
  }

  return (
    <SectionForm
      onSubmit={submit}
      formError={formError}
      pending={pending}
      submitLabel="Save matching"
    >
      <FieldGroup>
        <div className="grid grid-cols-2 gap-4">
          <SettingField
            name="experienceYears"
            label="Experience in years"
            error={errors["experienceYears"]}
          >
            <Input
              id="experienceYears"
              name="experienceYears"
              type="number"
              min={0}
              defaultValue={settings.experienceYears}
            />
          </SettingField>
          <SettingField
            name="experienceMonths"
            label="And months"
            error={errors["experienceMonths"]}
          >
            <Input
              id="experienceMonths"
              name="experienceMonths"
              type="number"
              defaultValue={settings.experienceMonths}
            />
          </SettingField>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <SettingField
            name="targetMinYears"
            label="Target minimum years"
            error={errors["targetMinYears"]}
          >
            <Input
              id="targetMinYears"
              name="targetMinYears"
              type="number"
              min={0}
              step="any"
              defaultValue={settings.targetMinYears ?? ""}
            />
          </SettingField>
          <SettingField
            name="targetMaxYears"
            label="Target maximum years"
            error={errors["targetMaxYears"]}
          >
            <Input
              id="targetMaxYears"
              name="targetMaxYears"
              type="number"
              min={0}
              step="any"
              defaultValue={settings.targetMaxYears ?? ""}
            />
          </SettingField>
        </div>
        <SettingField
          name="locations"
          label="Cities"
          error={errors["locations"]}
          hint="Separate cities with commas."
        >
          <Input
            id="locations"
            name="locations"
            defaultValue={settings.locations.join(", ")}
            placeholder="Bengaluru, Remote"
          />
        </SettingField>
        <SettingField
          name="titleInclude"
          label="Job titles must include"
          error={errors["titleInclude"]}
          hint="Any of these words or phrases, separated by commas. Leave empty to allow any title."
        >
          <Input
            id="titleInclude"
            name="titleInclude"
            defaultValue={settings.titleInclude.join(", ")}
            placeholder="Backend, Full stack"
          />
        </SettingField>
        <SettingField
          name="titleExclude"
          label="Job titles must not include"
          error={errors["titleExclude"]}
          hint="None of these words or phrases, separated by commas."
        >
          <Input
            id="titleExclude"
            name="titleExclude"
            defaultValue={settings.titleExclude.join(", ")}
            placeholder="Senior, Intern"
          />
        </SettingField>
        <Field orientation="horizontal">
          <Switch
            id="includeUnknown"
            checked={includeUnknown}
            onCheckedChange={setIncludeUnknown}
          />
          <FieldLabel htmlFor="includeUnknown">
            Include listings with unknown experience or location
          </FieldLabel>
        </Field>
      </FieldGroup>
    </SectionForm>
  );
}
