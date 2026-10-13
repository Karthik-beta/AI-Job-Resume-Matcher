import { isDiscordWebhookUrl, UpdateSettings } from "@job-matcher/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { validate } from "@/lib/validate";

export interface EditableSettings {
  readonly settings: UpdateSettings;
  // A webhook saved before only Discord URLs were accepted. It gets no alerts, so it is left out
  // of `settings` and flagged instead of failing every section.
  readonly refusedWebhook: string | null;
}

// Its own key under "settings": the plain ["settings"] query fails on a refused webhook.
export const editableSettingsKey = ["settings", "editable"] as const;

export function toEditableSettings(body: unknown): EditableSettings {
  const saved = (body as { discordWebhookUrl?: unknown } | null)?.discordWebhookUrl;
  const refused = typeof saved === "string" && !isDiscordWebhookUrl(saved) ? saved : null;
  const { value } = validate(
    UpdateSettings,
    refused ? { ...(body as object), discordWebhookUrl: null } : body,
  );
  if (!value) throw new Error("Could not read your settings.");
  return { settings: value, refusedWebhook: refused };
}

export const fetchEditableSettings = async () => toEditableSettings(await api("/settings"));

// The settings the sections edit, shared by every section on the page.
export const useEditableSettings = () =>
  useQuery({ queryKey: editableSettingsKey, queryFn: fetchEditableSettings });
