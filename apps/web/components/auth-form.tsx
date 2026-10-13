"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type SubmitEvent, Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { AFTER_SIGN_IN, AFTER_SIGN_UP, authHref, safeNext } from "@/lib/safe-next";

type Mode = "sign-in" | "sign-up";

const copy = {
  "sign-in": {
    title: "Sign in",
    submit: "Sign in",
    pending: "Signing in",
    switchText: "No account yet?",
    switchLabel: "Create an account",
    switchHref: "/sign-up",
  },
  "sign-up": {
    title: "Create an account",
    submit: "Create account",
    pending: "Creating account",
    switchText: "Already have an account?",
    switchLabel: "Sign in",
    switchHref: "/sign-in",
  },
} as const;

function field(data: FormData, name: string) {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

const errorMessages: Record<string, string> = {
  USER_ALREADY_EXISTS: "An account with this email already exists. Sign in instead.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    "An account with this email already exists. Sign in instead.",
  INVALID_EMAIL_OR_PASSWORD: "Email or password is incorrect.",
  PASSWORD_TOO_SHORT: "Password must be at least 8 characters.",
};

const unreachable = "Couldn't reach the server. Try again in a moment.";

function errorMessage(error: {
  code?: string | undefined;
  message?: string | undefined;
  status: number;
}) {
  const known = error.code ? errorMessages[error.code] : undefined;
  if (known) return known;
  if (error.status === 0 || error.status >= 500) return unreachable;
  return error.message ?? unreachable;
}

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const text = copy[mode];

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = field(data, "email");
    const password = field(data, "password");
    setError(null);
    setPending(true);
    try {
      const result =
        mode === "sign-up"
          ? await authClient.signUp.email({ name: field(data, "name"), email, password })
          : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(errorMessage(result.error));
        return;
      }
      // Read at submit time, so the form needs no Suspense boundary. `replace` keeps the auth
      // page out of history, so Back doesn't return to the form.
      const next = safeNext(new URLSearchParams(window.location.search).get("next"));
      router.replace(next ?? (mode === "sign-up" ? AFTER_SIGN_UP : AFTER_SIGN_IN));
      router.refresh();
    } catch {
      setError(unreachable);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-8">
      <h1 className="text-4xl font-extrabold tracking-[-0.03em]">{text.title}</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        <FieldGroup>
          {mode === "sign-up" && (
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input id="name" name="name" autoComplete="name" required />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
              minLength={8}
              required
            />
          </Field>
        </FieldGroup>
        {error && <FieldError>{error}</FieldError>}
        <Button type="submit" size="lg" disabled={pending} className="self-start">
          {pending ? text.pending : text.submit}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        {text.switchText}{" "}
        {/* `useSearchParams` sits inside Suspense so the page can still prerender. */}
        <Suspense fallback={<SwitchLink mode={mode} next={null} />}>
          <CurrentSwitchLink mode={mode} />
        </Suspense>
      </p>
    </div>
  );
}

function CurrentSwitchLink({ mode }: { mode: Mode }) {
  return <SwitchLink mode={mode} next={useSearchParams().get("next")} />;
}

// The link to the other auth page, carrying the `next` page across.
function SwitchLink({ mode, next }: { mode: Mode; next: string | null }) {
  const text = copy[mode];
  return (
    <Link
      href={authHref(text.switchHref, next)}
      className="font-medium text-foreground underline underline-offset-4"
    >
      {text.switchLabel}
    </Link>
  );
}
