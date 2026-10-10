"use client";

import { UpdateSettings } from "@job-matcher/shared";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ApiError, api } from "@/lib/api";
import { validate } from "@/lib/validate";

function text(data: FormData, name: string) {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(data: FormData, name: string) {
  return text(data, name) || null;
}

function optionalNumber(data: FormData, name: string) {
  const value = text(data, name);
  return value === "" ? null : Number(value);
}

function toInput(data: FormData, includeUnknown: boolean) {
  return {
    resumeUrl: optionalText(data, "resumeUrl"),
    discordWebhookUrl: optionalText(data, "discordWebhookUrl"),
    experienceYears: Number(text(data, "experienceYears")),
    experienceMonths: Number(text(data, "experienceMonths")),
    targetMinYears: optionalNumber(data, "targetMinYears"),
    targetMaxYears: optionalNumber(data, "targetMaxYears"),
    locations: text(data, "locations")
      .split(",")
      .map((city) => city.trim())
      .filter((city) => city !== ""),
    includeUnknown,
    maxJobsPerRun: Number(text(data, "maxJobsPerRun")),
    scheduleMinutes: optionalNumber(data, "scheduleMinutes"),
  };
}

export function PreferencesForm() {
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    api("/settings")
      .then((body) => {
        const { value } = validate(UpdateSettings, body);
        if (value) setSettings(value);
        else setLoadError(true);
      })
      .catch(() => setLoadError(true));
  }, []);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight">Matching preferences</h2>
        <p className="text-muted-foreground">
          Used to filter listings and check them against your resume.
        </p>
      </div>
      {loadError && <FieldError>Could not load your preferences.</FieldError>}
      {settings && <Form settings={settings} />}
    </section>
  );
}

function Form({ settings }: { settings: UpdateSettings }) {
  const [includeUnknown, setIncludeUnknown] = useState(settings.includeUnknown);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = toInput(new FormData(event.currentTarget), includeUnknown);
    const result = validate(UpdateSettings, input);
    setErrors(result.errors);
    if (!result.value) return;
    setPending(true);
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify(result.value) });
      toast.success("Preferences saved");
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "Could not save preferences.");
    } finally {
      setPending(false);
    }
  }

  function field(name: keyof UpdateSettings, label: string, input: ReactNode, hint?: string) {
    const error = errors[name];
    return (
      <Field data-invalid={error !== undefined}>
        <FieldLabel htmlFor={name}>{label}</FieldLabel>
        {input}
        {hint && <FieldDescription>{hint}</FieldDescription>}
        {error && <FieldError>{error}</FieldError>}
      </Field>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-xl flex-col gap-6">
      <FieldGroup>
        {field(
          "resumeUrl",
          "Resume URL",
          <Input
            id="resumeUrl"
            name="resumeUrl"
            defaultValue={settings.resumeUrl ?? ""}
            placeholder="https://example.com/resume.pdf"
          />,
        )}
        <div className="grid grid-cols-2 gap-4">
          {field(
            "experienceYears",
            "Experience in years",
            <Input
              id="experienceYears"
              name="experienceYears"
              type="number"
              min={0}
              defaultValue={settings.experienceYears}
            />,
          )}
          {field(
            "experienceMonths",
            "And months",
            <Input
              id="experienceMonths"
              name="experienceMonths"
              type="number"
              defaultValue={settings.experienceMonths}
            />,
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {field(
            "targetMinYears",
            "Target minimum years",
            <Input
              id="targetMinYears"
              name="targetMinYears"
              type="number"
              min={0}
              step="any"
              defaultValue={settings.targetMinYears ?? ""}
            />,
          )}
          {field(
            "targetMaxYears",
            "Target maximum years",
            <Input
              id="targetMaxYears"
              name="targetMaxYears"
              type="number"
              min={0}
              step="any"
              defaultValue={settings.targetMaxYears ?? ""}
            />,
          )}
        </div>
        {field(
          "locations",
          "Cities",
          <Input
            id="locations"
            name="locations"
            defaultValue={settings.locations.join(", ")}
            placeholder="Bengaluru, Remote"
          />,
          "Separate cities with commas.",
        )}
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
        {field(
          "maxJobsPerRun",
          "Jobs to check per run",
          <Input
            id="maxJobsPerRun"
            name="maxJobsPerRun"
            type="number"
            defaultValue={settings.maxJobsPerRun}
          />,
        )}
        {field(
          "discordWebhookUrl",
          "Discord webhook URL",
          <Input
            id="discordWebhookUrl"
            name="discordWebhookUrl"
            defaultValue={settings.discordWebhookUrl ?? ""}
          />,
          "Matches are posted to this channel. Leave empty to skip.",
        )}
        {field(
          "scheduleMinutes",
          "Check every N minutes",
          <Input
            id="scheduleMinutes"
            name="scheduleMinutes"
            type="number"
            defaultValue={settings.scheduleMinutes ?? ""}
          />,
          "Leave empty to run only when you start a run.",
        )}
      </FieldGroup>
      <Button type="submit" size="lg" disabled={pending} className="self-start">
        {pending ? "Saving" : "Save preferences"}
      </Button>
    </form>
  );
}
