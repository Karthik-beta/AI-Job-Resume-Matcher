"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { retrySave } from "@/lib/runs";

export function RetrySaveButton({ runId, resultId }: { runId: string; resultId: string }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => retrySave(runId, resultId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["runs", runId] });
      toast.success("Match saved.");
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not save the match."),
  });

  return (
    <Button
      variant="outline"
      size="sm"
      className="self-start"
      disabled={save.isPending}
      onClick={() => save.mutate()}
    >
      Retry saving match
    </Button>
  );
}
