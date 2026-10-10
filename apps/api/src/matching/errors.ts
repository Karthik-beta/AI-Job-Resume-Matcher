import { Data } from "effect";

export class OpenRouterAuthError extends Data.TaggedError("OpenRouterAuthError")<{
  readonly status: number;
  readonly message: string;
}> {}

export class OpenRouterUnavailable extends Data.TaggedError("OpenRouterUnavailable")<{
  readonly status: number;
  readonly message: string;
}> {}

export class OpenRouterRequestFailed extends Data.TaggedError("OpenRouterRequestFailed")<{
  readonly status: number | null;
  readonly message: string;
}> {}

export class ManagementKeyError extends Data.TaggedError("ManagementKeyError")<{
  readonly message: string;
}> {}

export class ModelUnsupported extends Data.TaggedError("ModelUnsupported")<{
  readonly model: string;
  readonly message: string;
}> {}

export class FirecrawlBlocked extends Data.TaggedError("FirecrawlBlocked")<{
  readonly status: number;
  readonly message: string;
}> {}

export class ScrapeFailed extends Data.TaggedError("ScrapeFailed")<{
  readonly status: number | null;
  readonly message: string;
}> {}

export class MatchOutputInvalid extends Data.TaggedError("MatchOutputInvalid")<{
  readonly message: string;
}> {}

export class SaveFailed extends Data.TaggedError("SaveFailed")<{
  readonly message: string;
}> {}

export class NotifyFailed extends Data.TaggedError("NotifyFailed")<{
  readonly message: string;
}> {}

export type MatchingError =
  | OpenRouterAuthError
  | OpenRouterUnavailable
  | OpenRouterRequestFailed
  | ManagementKeyError
  | ModelUnsupported
  | FirecrawlBlocked
  | ScrapeFailed
  | MatchOutputInvalid
  | SaveFailed
  | NotifyFailed;

export const stopsRun = (error: MatchingError): boolean => {
  switch (error._tag) {
    case "OpenRouterAuthError":
    case "OpenRouterUnavailable":
    case "ManagementKeyError":
    case "ModelUnsupported":
    case "FirecrawlBlocked":
      return true;
    case "OpenRouterRequestFailed":
    case "ScrapeFailed":
    case "MatchOutputInvalid":
    case "SaveFailed":
    case "NotifyFailed":
      return false;
  }
};

const openRouterUnavailableStatuses: ReadonlySet<number> = new Set([402, 403, 404, 429]);
const firecrawlBlockedStatuses: ReadonlySet<number> = new Set([401, 402, 429]);

// Other OpenRouter statuses (e.g. 5xx) only fail the current job, as in the Python app.
export const openRouterErrorFromStatus = (
  status: number,
  message: string,
): OpenRouterAuthError | OpenRouterUnavailable | OpenRouterRequestFailed => {
  if (status === 401) return new OpenRouterAuthError({ status, message });
  if (openRouterUnavailableStatuses.has(status)) {
    return new OpenRouterUnavailable({ status, message });
  }
  return new OpenRouterRequestFailed({ status, message });
};

export const firecrawlErrorFromStatus = (
  status: number,
  message: string,
): FirecrawlBlocked | ScrapeFailed =>
  firecrawlBlockedStatuses.has(status)
    ? new FirecrawlBlocked({ status, message })
    : new ScrapeFailed({ status, message });
