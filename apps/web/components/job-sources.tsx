"use client";

import {
  CreateJobSource,
  CreateSearchSource,
  SourceKind,
  sourceKindLabels,
  UpdateJobSource,
} from "@job-matcher/shared";
import { Option, Schema } from "effect";
import { type SubmitEvent, useEffect, useRef, useState } from "react";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ApiError, api } from "@/lib/api";
import { validate } from "@/lib/validate";

const Source = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  kind: SourceKind,
  adapterKey: Schema.NullOr(Schema.String),
  suggestedKind: Schema.NullOr(SourceKind),
  suggestedAdapterKey: Schema.NullOr(Schema.String),
  useMap: Schema.Boolean,
  query: Schema.NullOr(Schema.String),
});
type Source = typeof Source.Type;

const decodeSource = Schema.decodeUnknownOption(Source);
const isSource = Schema.is(Source);

function toSources(value: unknown): Source[] {
  return Array.isArray(value) ? value.filter(isSource) : [];
}

// Search sources are created from a query, so they are not offered here.
const editableKinds = SourceKind.literals.filter((kind) => kind !== "SEARCH");

export type JobSource = Source;

export function JobSources({
  onAdded,
  onChange,
  className,
}: {
  // Called with each source the user adds.
  onAdded?: ((source: JobSource) => void) | undefined;
  // Called with the whole list once it loads and after every change.
  onChange?: ((sources: readonly JobSource[]) => void) | undefined;
  className?: string | undefined;
}) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (sources !== null) onChangeRef.current?.(sources);
  }, [sources]);

  function add(created: Source) {
    setSources((current) => [created, ...(current ?? [])]);
    onAdded?.(created);
  }
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    api("/sources")
      .then((value) => setSources(toSources(value)))
      .catch(() => setError("Could not load job sources."));
  }, []);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const { value, errors } = validate(CreateJobSource, { url });
    if (!value) {
      setError(errors["url"] ?? "Enter a valid URL");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const created = await api("/sources", { method: "POST", body: JSON.stringify(value) });
      if (isSource(created)) add(created);
      setUrl("");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not add the source.");
    } finally {
      setPending(false);
    }
  }

  async function remove(id: string) {
    try {
      await api(`/sources/${id}`, { method: "DELETE" });
      setSources((current) => (current ?? []).filter((source) => source.id !== id));
    } catch {
      setError("Could not delete the source.");
    }
  }

  function replace(updated: Source) {
    setSources((current) =>
      (current ?? []).map((source) => (source.id === updated.id ? updated : source)),
    );
  }

  return (
    <SettingsSection
      id="sources"
      title="Job sources"
      description="Careers pages and job boards to check on each run. Greenhouse, Lever, Ashby, SmartRecruiters and Recruitee boards are read from their public APIs."
      className={className}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <Field data-invalid={error !== null}>
          <FieldLabel htmlFor="source-url">Careers page URL</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="source-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/careers"
              aria-invalid={error !== null}
            />
            <Button type="submit" disabled={pending}>
              Add source
            </Button>
          </div>
          {error && <FieldError>{error}</FieldError>}
        </Field>
      </form>
      <SearchForm onAdded={add} />
      {sources !== null &&
        (sources.length === 0 ? (
          <div className="flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
            <p className="text-base">No job sources yet. Add a careers page URL to start.</p>
            <p>Job board links like these are read from the board directly, at no cost:</p>
            <ul className="flex flex-col gap-0.5 font-mono text-xs">
              <li>https://boards.greenhouse.io/yourcompany</li>
              <li>https://jobs.lever.co/yourcompany</li>
              <li>https://jobs.ashbyhq.com/yourcompany</li>
              <li>https://jobs.smartrecruiters.com/yourcompany</li>
              <li>https://yourcompany.recruitee.com</li>
            </ul>
            <p>
              Any other careers page works too. Or search the job boards by role, like “backend
              engineer typescript”.
            </p>
          </div>
        ) : (
          <ul className="divide-y border-y">
            {sources.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                onUpdated={replace}
                onRemove={() => remove(source.id)}
              />
            ))}
          </ul>
        ))}
    </SettingsSection>
  );
}

// A web search of the ATS job boards for the past week's ads, run at most once a day.
function SearchForm({ onAdded }: { onAdded: (source: Source) => void }) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const { value, errors } = validate(CreateSearchSource, { query });
    if (!value) {
      setError(errors["query"] ?? "Enter what to search for");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const created = await api("/sources/search", {
        method: "POST",
        body: JSON.stringify(value),
      });
      if (isSource(created)) onAdded(created);
      setQuery("");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not add the search.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <Field data-invalid={error !== null}>
        <FieldLabel htmlFor="source-query">Search job boards</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="source-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="backend engineer typescript"
            aria-invalid={error !== null}
          />
          <Button type="submit" variant="outline" disabled={pending}>
            Add search
          </Button>
        </div>
        <FieldDescription>
          Finds the past week's ads on Greenhouse, Lever, Ashby, SmartRecruiters and Recruitee
          boards. Runs at most once a day, for 2 Firecrawl credits.
        </FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </Field>
    </form>
  );
}

function SourceRow({
  source,
  onUpdated,
  onRemove,
}: {
  source: Source;
  onUpdated: (source: Source) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<SourceKind>(source.kind);
  const [adapterKey, setAdapterKey] = useState(source.adapterKey ?? "");
  const [useMap, setUseMap] = useState(source.useMap);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function update(nextKind: SourceKind, nextKey: string | null, nextUseMap = useMap) {
    const { value, errors } = validate(UpdateJobSource, {
      kind: nextKind,
      adapterKey: nextKey,
      useMap: nextUseMap,
    });
    if (!value) {
      setError(errors["adapterKey"] ?? errors["kind"] ?? "Check the source type");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const updated = decodeSource(
        await api(`/sources/${source.id}`, { method: "PATCH", body: JSON.stringify(value) }),
      );
      if (Option.isNone(updated)) {
        setError("The source was updated, but its details could not be read. Refresh the page.");
        return;
      }
      onUpdated(updated.value);
      setKind(updated.value.kind);
      setAdapterKey(updated.value.adapterKey ?? "");
      setUseMap(updated.value.useMap);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not update the source.");
    } finally {
      setPending(false);
    }
  }

  // Cancelling drops the unsaved type, board name and map choice.
  function toggleEditing() {
    if (editing) {
      setKind(source.kind);
      setAdapterKey(source.adapterKey ?? "");
      setUseMap(source.useMap);
      setError(null);
    }
    setEditing(!editing);
  }

  function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    return update(kind, kind === "PAGE" ? null : adapterKey);
  }

  const { suggestedKind, suggestedAdapterKey } = source;

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant={source.kind === "PAGE" ? "outline" : "secondary"}>
            {sourceKindLabels[source.kind]}
            {source.adapterKey ? `: ${source.adapterKey}` : ""}
          </Badge>
          {source.kind === "PAGE" && source.useMap && <Badge variant="outline">Site map</Badge>}
          <span className="truncate">{source.query ?? source.url}</span>
        </div>
        <div className="flex shrink-0 gap-2">
          {source.kind !== "SEARCH" && (
            <Button variant="outline" size="sm" onClick={toggleEditing}>
              {editing ? "Cancel" : "Change type"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onRemove}>
            Delete
          </Button>
        </div>
      </div>
      {suggestedKind && suggestedAdapterKey && source.kind === "PAGE" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
          <span>
            This page embeds a {sourceKindLabels[suggestedKind]} board. Reading its API is faster
            and costs no Firecrawl credits.
          </span>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => update(suggestedKind, suggestedAdapterKey)}
          >
            Switch to {sourceKindLabels[suggestedKind]}
          </Button>
        </div>
      )}
      {!editing && error && <p className="text-sm text-destructive">{error}</p>}
      {editing && (
        <form onSubmit={save}>
          <Field data-invalid={error !== null}>
            <FieldLabel htmlFor={`kind-${source.id}`} className="sr-only">
              Source type
            </FieldLabel>
            <div className="flex flex-wrap items-center gap-2">
              <select
                id={`kind-${source.id}`}
                value={kind}
                onChange={(event) => {
                  const next = editableKinds.find((value) => value === event.target.value);
                  if (next) setKind(next);
                }}
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30"
              >
                {editableKinds.map((value) => (
                  <option key={value} value={value}>
                    {sourceKindLabels[value]}
                  </option>
                ))}
              </select>
              {kind !== "PAGE" && (
                <Input
                  aria-label="Board name"
                  value={adapterKey}
                  onChange={(event) => setAdapterKey(event.target.value)}
                  placeholder="Board name, e.g. stripe"
                  aria-invalid={error !== null}
                  className="w-48"
                />
              )}
              <Button type="submit" size="sm" disabled={pending}>
                Save
              </Button>
            </div>
            {error && <FieldError>{error}</FieldError>}
          </Field>
          {kind === "PAGE" && (
            <Field orientation="horizontal" className="mt-3">
              <Switch id={`map-${source.id}`} checked={useMap} onCheckedChange={setUseMap} />
              <FieldLabel htmlFor={`map-${source.id}`}>
                Find job links in Firecrawl's map of the site instead (1 credit; the page is still
                read when the map has none)
              </FieldLabel>
            </Field>
          )}
        </form>
      )}
    </li>
  );
}
