import { useState } from "react";
import { authClient } from "@/lib/auth-client";

// Hints a user has closed, remembered per user in this browser. Storage is a convenience: when
// it is unavailable the hint closes for this visit only.
const storageKey = (name: string, userId: string | undefined) =>
  `job-matcher:dismissed:${name}:${userId ?? "anonymous"}`;

function readDismissed(key: string) {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

// Read during render: the hints sit inside signed-in pages, which only render in the browser.
export function useDismissed(name: string) {
  const { data: session } = authClient.useSession();
  const key = storageKey(name, session?.user.id);
  const [closed, setClosed] = useState<string | null>(null);
  const dismissed = closed === key || readDismissed(key);

  const dismiss = () => {
    try {
      window.localStorage.setItem(key, new Date().toISOString());
    } catch {
      // Storage is unavailable; the hint still closes for this visit.
    }
    setClosed(key);
  };

  return { dismissed, dismiss };
}
