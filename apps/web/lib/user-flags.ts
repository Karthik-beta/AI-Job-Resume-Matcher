import { useState } from "react";
import { authClient } from "@/lib/auth-client";

// Small per-user flags remembered in this browser: hints a user has closed, and how far they
// got through setup. Storage is a convenience: when it is unavailable a flag lasts for this
// visit only.
const flagKey = (name: string, userId: string) => `job-matcher:${name}:${userId}`;

function readFlag(key: string) {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    if (on) window.localStorage.setItem(key, new Date().toISOString());
    else window.localStorage.removeItem(key);
  } catch {
    // Storage is unavailable; the flag holds for this visit only.
  }
}

// Read during render: the flags are used inside signed-in pages, which only render in the
// browser. Until the session is known there is no user to key the flag by, so `ready` is false,
// `on` is false and `set` does nothing.
export function useUserFlag(name: string) {
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const key = userId === undefined ? null : flagKey(name, userId);
  const [local, setLocal] = useState<{ key: string; on: boolean } | null>(null);
  const on = key !== null && (local?.key === key ? local.on : readFlag(key));

  const set = (value: boolean) => {
    if (key === null) return;
    writeFlag(key, value);
    setLocal({ key, on: value });
  };

  return { ready: key !== null, on, set };
}

// A hint the user can close. It counts as closed until the session is known, so it never
// flashes for a user who closed it earlier.
export function useDismissed(name: string) {
  const flag = useUserFlag(`dismissed:${name}`);
  return { dismissed: !flag.ready || flag.on, dismiss: () => flag.set(true) };
}
