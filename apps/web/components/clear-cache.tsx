"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const deletedCount = (body: unknown) =>
  typeof body === "object" && body !== null && "deleted" in body && typeof body.deleted === "number"
    ? body.deleted
    : 0;

function clearedMessage(deleted: number) {
  if (deleted === 0) return "There was no saved scrape data to clear.";
  return deleted === 1 ? "Cleared 1 saved page." : `Cleared ${deleted} saved pages.`;
}

export function ClearCache() {
  const [open, setOpen] = useState(false);
  const clear = useMutation({
    mutationFn: async () => deletedCount(await api("/cache", { method: "DELETE" })),
    onSuccess: (deleted) => {
      setOpen(false);
      toast.success(clearedMessage(deleted));
    },
    onError: () => toast.error("Could not clear saved scrape data."),
  });

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight">Saved scrape data</h2>
        <p className="text-muted-foreground">
          Your resume and job pages are saved after the first scrape, and job board listings for 15
          minutes. Clear them after updating your resume or when a board has changed.
        </p>
      </div>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger render={<Button variant="outline" className="self-start" />}>
          Clear saved scrape data
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear saved scrape data?</AlertDialogTitle>
            <AlertDialogDescription>
              The next run will scrape your resume and every page again, which uses Firecrawl
              credits.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={clear.isPending} onClick={() => clear.mutate()}>
              Clear data
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
