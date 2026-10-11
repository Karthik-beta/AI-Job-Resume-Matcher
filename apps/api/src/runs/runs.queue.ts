export const runsQueue = "runs";

export interface RunJob {
  readonly runId: string;
}

// Repeating job created by a user's schedule; each tick starts a SCHEDULED run.
export const scheduledJob = "scheduled";

export interface ScheduledJob {
  readonly userId: string;
}

export const schedulerId = (userId: string) => `user:${userId}`;
