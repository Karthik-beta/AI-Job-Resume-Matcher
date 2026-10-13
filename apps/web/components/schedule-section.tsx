"use client";

import type { UpdateSettings } from "@job-matcher/shared";
import {
  optionalNumber,
  optionalText,
  SectionForm,
  SettingField,
  SettingsLoader,
  SettingsSection,
  useSectionSave,
} from "@/components/settings-section";
import { FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { EditableSettings } from "@/lib/settings";

const fields = ["scheduleMinutes", "discordWebhookUrl"] as const;

export function ScheduleSection({
  onSaved,
  className,
}: {
  onSaved?: ((settings: UpdateSettings) => void) | undefined;
  className?: string | undefined;
}) {
  return (
    <SettingsSection
      id="schedule"
      title="Schedule & alerts"
      description="Run on a timer and get new matches posted to Discord, so you hear about a job without opening the app."
      className={className}
    >
      <SettingsLoader>
        {(editable) => <ScheduleForm editable={editable} onSaved={onSaved} />}
      </SettingsLoader>
    </SettingsSection>
  );
}

function ScheduleForm({
  editable: { settings, refusedWebhook },
  onSaved,
}: {
  editable: EditableSettings;
  onSaved: ((settings: UpdateSettings) => void) | undefined;
}) {
  const { errors, formError, pending, save } = useSectionSave({
    fields,
    savedMessage: "Schedule and alerts saved",
    onSaved,
    initialErrors: refusedWebhook
      ? {
          discordWebhookUrl:
            "Alerts are not being sent: this is not a Discord webhook URL. Replace it or clear it.",
        }
      : {},
  });

  return (
    <SectionForm
      onSubmit={(data) =>
        void save({
          scheduleMinutes: optionalNumber(data, "scheduleMinutes"),
          discordWebhookUrl: optionalText(data, "discordWebhookUrl"),
        })
      }
      formError={formError}
      pending={pending}
      submitLabel="Save schedule and alerts"
    >
      <FieldGroup>
        <SettingField
          name="scheduleMinutes"
          label="Check every N minutes"
          error={errors["scheduleMinutes"]}
          hint="Leave empty to run only when you start a run."
        >
          <Input
            id="scheduleMinutes"
            name="scheduleMinutes"
            type="number"
            defaultValue={settings.scheduleMinutes ?? ""}
          />
        </SettingField>
        <SettingField
          name="discordWebhookUrl"
          label="Discord webhook URL"
          error={errors["discordWebhookUrl"]}
          hint="Matches are posted to this channel. Leave empty to skip."
        >
          <Input
            id="discordWebhookUrl"
            name="discordWebhookUrl"
            defaultValue={settings.discordWebhookUrl ?? refusedWebhook ?? ""}
          />
        </SettingField>
      </FieldGroup>
    </SectionForm>
  );
}
