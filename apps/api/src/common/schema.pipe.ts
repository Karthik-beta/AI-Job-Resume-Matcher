import { BadRequestException, type PipeTransform } from "@nestjs/common";
import { Result, Schema } from "effect";

export class SchemaPipe<S extends Schema.ConstraintDecoder<unknown>> implements PipeTransform {
  constructor(private readonly schema: S) {}

  transform(value: unknown): S["Type"] {
    const result = Schema.decodeUnknownResult(this.schema)(value);
    if (Result.isFailure(result)) throw new BadRequestException(result.failure.message);
    return result.success;
  }
}
