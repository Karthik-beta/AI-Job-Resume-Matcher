import type { PrismaClient, Run, RunTrigger } from "../generated/prisma/client";
import { contextKey } from "../matching/context-key";
import { requirementsOf, titleFiltersOf } from "./run-settings";

export type CreateRunResult =
  | { readonly _tag: "Created"; readonly run: Run }
  | { readonly _tag: "NoResume" }
  | { readonly _tag: "SourceNotFound" }
  | { readonly _tag: "AlreadyActive" };

export const createRun = (
  prisma: PrismaClient,
  options: {
    readonly userId: string;
    readonly sourceIds: readonly string[];
    readonly trigger: RunTrigger;
    readonly model: string;
  },
): Promise<CreateRunResult> => {
  const { userId, trigger, model } = options;
  const ids = [...new Set(options.sourceIds)];
  return prisma.$transaction(async (tx) => {
    // Serialises starts per user, so two quick requests cannot both pass the active-run check.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

    const settings = await tx.settings.findUnique({ where: { userId } });
    if (!settings?.resumeUrl) return { _tag: "NoResume" };
    const owned = await tx.jobSource.count({ where: { userId, id: { in: ids } } });
    if (ids.length === 0 || owned !== ids.length) return { _tag: "SourceNotFound" };

    const active = await tx.run.findFirst({
      where: { userId, status: { in: ["QUEUED", "RUNNING"] } },
      select: { id: true },
    });
    if (active) return { _tag: "AlreadyActive" };

    const run = await tx.run.create({
      data: {
        userId,
        trigger,
        sourceIds: ids,
        // Provisional: the worker replaces it once it has the resume content hash.
        contextKey: contextKey({
          resumeHash: settings.resumeUrl,
          sourceIds: ids,
          model,
          requirements: requirementsOf(settings),
          titleFilters: titleFiltersOf(settings),
        }),
      },
    });
    return { _tag: "Created", run };
  });
};

// Each schedule tick covers all of the user's sources.
export const createScheduledRun = async (prisma: PrismaClient, userId: string, model: string) => {
  const sources = await prisma.jobSource.findMany({ where: { userId }, select: { id: true } });
  const created = await createRun(prisma, {
    userId,
    sourceIds: sources.map(({ id }) => id),
    trigger: "SCHEDULED",
    model,
  });
  return created._tag === "Created" ? created.run : null;
};
