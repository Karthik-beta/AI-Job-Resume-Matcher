import { Onboarding } from "@job-matcher/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { type Overview, overviewKey } from "@/lib/overview";
import { useUserFlag } from "@/lib/user-flags";

export type { Onboarding };

const decodeOnboarding = Schema.decodeUnknownSync(Onboarding);

type Action = "dismiss" | "restore";

const post = async (action: Action) =>
  decodeOnboarding(await api(`/onboarding/${action}`, { method: "POST" }));

// Each action returns the new onboarding state: it is written into the cached overview at once,
// then the overview is refetched for anything else that changed.
function useOnboardingAction(action: Action) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => post(action),
    onSuccess: (onboarding) => {
      queryClient.setQueryData<Overview>(overviewKey, (overview) =>
        overview ? { ...overview, onboarding } : overview,
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: overviewKey }),
  });
}

// Hides the setup checklist.
export const useDismissOnboarding = () => useOnboardingAction("dismiss");
// Shows the setup checklist again.
export const useRestoreOnboarding = () => useOnboardingAction("restore");

// Whether the user chose "Use defaults" on the wizard's matching step, so setup continues past
// it. Kept in the browser: the API only knows whether settings differ from the defaults.
export const useSkippedPreferences = () => useUserFlag("onboarding-skipped-preferences");

// Remembers that this browser saw the user's setup unfinished. The "You're all set" card is
// shown only then, so users whose setup was marked done without them going through it (such as
// accounts that already had runs) never get it.
export function useSeenIncompleteOnboarding(onboarding: Onboarding | undefined) {
  const seen = useUserFlag("onboarding-seen-incomplete");
  const incomplete = onboarding !== undefined && onboarding.completedAt === null;
  const { ready, on, set } = seen;
  useEffect(() => {
    if (incomplete && ready && !on) set(true);
  }, [incomplete, ready, on, set]);
  return seen;
}
