"use client";

import {
  CreateJobSource,
  SourceKind,
  sourceKindLabels,
  UpdateJobSource,
} from "@job-matcher/shared";
import { Option, Schema } from "effect";
import { type SubmitEvent, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api";
import { validate } from "@/lib/validate";

const Source = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  kind: SourceKind,
  adapterKey: Schema.NullOr(Schema.String),
});
type Source = typeof Source.Type;

const decodeSource = Schema.decodeUnknownOption(Source);
const isSource = Schema.is(Source);

function toSources(value: unknown): Source[] {
  return Array.isArray(value) ? value.filter(isSource) : [];
}

// Search sources are created from a query, so they are not offered here.
const editableKinds = SourceKind.literals.filter((kind) => kind !== "SEARCH");

export function JobSources() {
  const [sources, setSources] = useState<Source[] | null>(null);
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
      if (isSource(created)) setSources((current) => [created, ...(current ?? [])]);
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
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight">Job sources</h2>
        <p className="text-muted-foreground">
          Careers pages and job boards to check on each run. Greenhouse, Lever, Ashby,
          SmartRecruiters and Recruitee boards are read from their public APIs.
        </p>
      </div>
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
      {sources !== null &&
        (sources.length === 0 ? (
          <p className="text-muted-foreground">
            No job sources yet. Add a careers page URL to start.
          </p>
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
    </section>
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
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const { value, errors } = validate(UpdateJobSource, {
      kind,
      adapterKey: kind === "PAGE" ? null : adapterKey,
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
      if (Option.isSome(updated)) onUpdated(updated.value);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not update the source.");
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant={source.kind === "PAGE" ? "outline" : "secondary"}>
            {sourceKindLabels[source.kind]}
            {source.adapterKey ? `: ${source.adapterKey}` : ""}
          </Badge>
          <span className="truncate">{source.url}</span>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing((open) => !open)}>
            {editing ? "Cancel" : "Change type"}
          </Button>
          <Button variant="outline" size="sm" onClick={onRemove}>
            Delete
          </Button>
        </div>
      </div>
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
        </form>
      )}
    </li>
  );
}
