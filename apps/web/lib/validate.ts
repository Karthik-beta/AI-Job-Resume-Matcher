import { Schema } from "effect";

export function validate<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) {
  const result = Schema.toStandardSchemaV1(schema)["~standard"].validate(input);
  if (result instanceof Promise) throw new Error("Async schemas are not supported");
  if (!result.issues) return { value: result.value, errors: {} };
  const errors: Record<string, string> = {};
  for (const issue of result.issues) {
    const key = String(issue.path?.[0] ?? "form");
    errors[key] ??= issue.message;
  }
  return { value: null, errors };
}
