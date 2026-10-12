import { Clock, Context, Duration, Effect, Layer, Ref, Schema } from "effect";
import { HttpFetch, isSuccess } from "../download";
import { ScrapeFailed } from "../errors";

// Public ATS APIs have no published limits, so requests to one host stay politely spaced.
const atsRequestSpacingMs = 1_500;

export class HostLimiter extends Context.Service<
  HostLimiter,
  { readonly waitForTurn: (host: string) => Effect.Effect<void> }
>()("HostLimiter") {}

export const makeHostLimiter = (spacingMs: number) =>
  Effect.gen(function* () {
    const nextRequestAt = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    return HostLimiter.of({
      // Each caller reserves the host's next slot before sleeping, as in firecrawl.ts.
      waitForTurn: (host) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const delay = yield* Ref.modify(nextRequestAt, (next) => {
            const start = Math.max(now, next.get(host) ?? 0);
            return [start - now, new Map(next).set(host, start + spacingMs)] as const;
          });
          if (delay > 0) yield* Effect.sleep(Duration.millis(delay));
        }),
    });
  });

export const hostLimiterLayer = Layer.effect(HostLimiter, makeHostLimiter(atsRequestSpacingMs));

export interface JsonRequest {
  // Names the API in error messages, e.g. "Greenhouse".
  readonly label: string;
  readonly notFound: string;
}

export const fetchJson = <S extends Schema.Decoder<unknown>>(
  url: string,
  schema: S,
  { label, notFound }: JsonRequest,
) =>
  Effect.gen(function* () {
    const http = yield* HttpFetch;
    const limiter = yield* HostLimiter;
    yield* limiter.waitForTurn(new URL(url).hostname);
    const { status, body } = yield* http.request(url, {
      headers: { accept: "application/json" },
    });
    if (status === 404) return yield* new ScrapeFailed({ status, message: notFound });
    if (!isSuccess(status)) {
      return yield* new ScrapeFailed({ status, message: `${label} returned HTTP ${status}.` });
    }
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(new TextDecoder().decode(body)),
      catch: () => new ScrapeFailed({ status, message: `${label} returned invalid JSON.` }),
    });
    return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError(
        (error) =>
          new ScrapeFailed({
            status,
            message: `${label} returned unexpected data: ${error.message}`,
          }),
      ),
    );
  });
