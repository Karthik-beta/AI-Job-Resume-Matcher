"use client";

import { UpdateSettings } from "@job-matcher/shared";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { createContext, type ReactNode, type SubmitEvent, use, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api } from "@/lib/api";
import { serialQueue } from "@/lib/serial";
import {
  type EditableSettings,
  editableSettingsKey,
  fetchEditableSettings,
  toEditableSettings,
  useEditableSettings,
} from "@/lib/settings";
import { validate } from "@/lib/validate";

export const settingsSections = [
  { id: "resume", label: "Resume" },
  { id: "sources", label: "Job sources" },
  { id: "matching", label: "Matching" },
  { id: "runs", label: "Runs" },
  { id: "schedule", label: "Schedule & alerts" },
  { id: "data", label: "Data" },
] as const;
export type SettingsSectionId = (typeof settingsSections)[number]["id"];

const EmbeddedContext = createContext(false);

// Sections inside this render only their form, without heading, description or anchor, for a
// page that introduces them itself (the setup wizard). The settings page does not use it.
export function EmbeddedSections({ children }: { children: ReactNode }) {
  return <EmbeddedContext value={true}>{children}</EmbeddedContext>;
}

// A titled block with an anchor. The heading takes focus when the page is opened at its hash.
export function SettingsSection({
  id,
  title,
  description,
  className,
  children,
}: {
  id: SettingsSectionId;
  title: string;
  description: ReactNode;
  className?: string | undefined;
  children: ReactNode;
}) {
  const embedded = use(EmbeddedContext);
  const headingId = `${id}-heading`;
  if (embedded) {
    return <div className={cn("flex flex-col gap-6", className)}>{children}</div>;
  }
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn("flex scroll-mt-6 flex-col gap-6", className)}
    >
      <div className="flex flex-col gap-1">
        <h2
          id={headingId}
          tabIndex={-1}
          data-section-heading
          className="rounded-sm text-2xl font-bold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {title}
        </h2>
        <p className="text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function SettingField({
  name,
  label,
  error,
  hint,
  children,
}: {
  name: keyof UpdateSettings;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      {children}
      {hint && <FieldDescription>{hint}</FieldDescription>}
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}

export function text(data: FormData, name: string) {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function optionalText(data: FormData, name: string) {
  return text(data, name) || null;
}

export function optionalNumber(data: FormData, name: string) {
  const value = text(data, name);
  return value === "" ? null : Number(value);
}

// "Bengaluru, Remote" as ["Bengaluru", "Remote"].
export function list(data: FormData, name: string) {
  return text(data, name)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

type Errors = Partial<Record<string, string>>;
type FormError = ReactNode;

// PUT /api/settings replaces every setting, so a section's fields are merged into the saved
// settings. A refused webhook is put back so it fails validation instead of being cleared.
function merge(base: EditableSettings, input: Partial<UpdateSettings>) {
  return {
    ...base.settings,
    ...(base.refusedWebhook ? { discordWebhookUrl: base.refusedWebhook } : {}),
    ...input,
  };
}

// The errors on this section's fields, and one message for any other saved setting that fails.
function splitErrors(errors: Record<string, string>, fields: readonly (keyof UpdateSettings)[]) {
  const own: Errors = {};
  let other: FormError = null;
  for (const [key, message] of Object.entries(errors)) {
    if ((fields as readonly string[]).includes(key)) own[key] = message;
    else
      other ??=
        key === "discordWebhookUrl"
          ? webhookError
          : "Another saved setting is not valid. Fix it, then save again.";
  }
  return { own, other };
}

// The server refuses a non-Discord webhook on every save, so it cannot be kept silently and
// clearing it would drop the user's data. The link works from any page that shows a section.
const webhookError = (
  <>
    Your saved Discord webhook URL is not valid. Replace or clear it under{" "}
    <a href="/settings#schedule" className="underline underline-offset-4">
      Settings, Schedule &amp; alerts
    </a>
    , then save again.
  </>
);

// Every section save in this tab runs after the previous one finished, so a save's fresh read
// already holds the fields another section just saved and its full PUT does not revert them.
// Saves from another tab can still interleave; the last one then wins for the fields it read.
const settingsSaves = serialQueue();

// Saves only `fields`, keeping every other setting as it is saved now.
export function useSectionSave({
  fields,
  savedMessage,
  onSaved,
  initialErrors = {},
}: {
  fields: readonly (keyof UpdateSettings)[];
  savedMessage: string;
  onSaved: ((settings: UpdateSettings) => void) | undefined;
  initialErrors?: Errors;
}) {
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<Errors>(initialErrors);
  const [formError, setFormError] = useState<FormError>(null);
  const [pending, setPending] = useState(false);

  function check(base: EditableSettings, input: Partial<UpdateSettings>) {
    const result = validate(UpdateSettings, merge(base, input));
    const { own, other } = splitErrors(result.errors, fields);
    setErrors(own);
    setFormError(other);
    return result.value;
  }

  async function save(input: Partial<UpdateSettings>) {
    // Check the fields first against the loaded settings, then against a fresh copy so a change
    // saved elsewhere since the page loaded is kept.
    const loaded = queryClient.getQueryData<EditableSettings>(editableSettingsKey);
    if (loaded && !check(loaded, input)) return;
    setPending(true);
    try {
      const saved = await settingsSaves(async () => {
        const fresh = await queryClient.fetchQuery({
          queryKey: editableSettingsKey,
          queryFn: fetchEditableSettings,
          staleTime: 0,
        });
        const value = check(fresh, input);
        if (!value) return null;
        const body = await api("/settings", { method: "PUT", body: JSON.stringify(value) });
        const next = toEditableSettings(body);
        // Set before the next queued save runs, so nothing reads the settings from before this one.
        queryClient.setQueryData(editableSettingsKey, next);
        return next;
      });
      if (!saved) return;
      void queryClient.invalidateQueries({ queryKey: ["settings"], exact: true });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      toast.success(savedMessage);
      onSaved?.(saved.settings);
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : "Could not save. Try again.");
    } finally {
      setPending(false);
    }
  }

  return { errors, formError, pending, save };
}

// Loads the settings for a section and renders its form once they are known.
export function SettingsLoader({
  children,
}: {
  children: (editable: EditableSettings) => ReactNode;
}) {
  const query = useEditableSettings();
  if (query.data) return children(query.data);
  if (query.isError) return <FieldError>Could not load your settings.</FieldError>;
  return (
    <div aria-busy="true" className="flex max-w-xl flex-col gap-3">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-2/3" />
    </div>
  );
}

export function SectionForm({
  onSubmit,
  formError,
  pending,
  submitLabel,
  children,
}: {
  onSubmit: (data: FormData) => void;
  formError: ReactNode;
  pending: boolean;
  submitLabel: string;
  children: ReactNode;
}) {
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(new FormData(event.currentTarget));
  }

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-6">
      {children}
      {formError && <FieldError>{formError}</FieldError>}
      <Button type="submit" size="lg" disabled={pending} className="self-start">
        {pending ? "Saving" : submitLabel}
      </Button>
    </form>
  );
}
