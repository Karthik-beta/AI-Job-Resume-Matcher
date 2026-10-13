import { Onboarding } from "@job-matcher/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { api } from "@/lib/api";
import { type Overview, overviewKey } from "@/lib/overview";

export type { Onboarding };

const decodeOnboarding = Schema.decodeUnknownSync(Onboarding);

const post = async (action: "complete" | "dismiss" | "restore") =>
  decodeOnboarding(await api(`/onboarding/${action}`, { method: "POST" }));

// Each action returns the new onboarding state: it is written into the cached overview at once,
// then the overview is refetched for anything else that changed.
function useOnboardingAction(action: "complete" | "dismiss" | "restore") {
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

// Marks the setup wizard finished.
export const useCompleteOnboarding = () => useOnboardingAction("complete");
// Hides the setup checklist.
export const useDismissOnboarding = () => useOnboardingAction("dismiss");
// Shows the setup checklist again.
export const useRestoreOnboarding = () => useOnboardingAction("restore");
