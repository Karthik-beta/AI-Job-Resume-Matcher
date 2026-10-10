"use client";

import { CreateJobSource } from "@job-matcher/shared";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, api } from "@/lib/api";
import { validate } from "@/lib/validate";

type Source = { id: string; url: string };

function isSource(value: unknown): value is Source {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "url" in value &&
    typeof value.url === "string"
  );
}

function toSources(value: unknown): Source[] {
  return Array.isArray(value) ? value.filter(isSource) : [];
}

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

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
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

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight">Job sources</h2>
        <p className="text-muted-foreground">Careers pages and job boards to check on each run.</p>
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
              <li key={source.id} className="flex items-center justify-between gap-4 py-3">
                <span className="truncate">{source.url}</span>
                <Button variant="outline" size="sm" onClick={() => remove(source.id)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
