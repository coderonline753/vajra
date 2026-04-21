/**
 * Vajra Validator
 * Zod integration for route-level validation with type inference.
 * Throws ValidationError (RSD Route layer error) on failure.
 *
 * When @vajrajs/native is installed and registered, the happy path routes
 * through the compiled fast validator (1.1-1.3x faster on shape-compilable
 * schemas). Error accumulation across body/query/params still uses Zod's
 * safeParse to preserve the multi-error response shape clients expect.
 */

import type { Context } from './context';
import type { Middleware } from './middleware';
import type { ZodSchema, ZodError, ZodTypeAny } from 'zod';
import { ValidationError as VajraValidationError } from './errors';
import { getNativeAccelerator } from './native-bridge';

interface ValidationSchemas {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
  headers?: ZodSchema;
}

interface FieldError {
  field: string;
  message: string;
  path: (string | number)[];
}

function formatZodErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || 'unknown',
    message: issue.message,
    path: issue.path,
  }));
}

type FastValidator = (input: unknown) => unknown;
const fastCache = new WeakMap<ZodTypeAny, FastValidator>();

/**
 * Resolve a happy-path validator for a schema.
 *
 * - When the native accelerator is registered, use its shape-compiled
 *   validator (throws TypeError on mismatch).
 * - When absent, skip the fast path entirely and signal "use Zod safeParse
 *   directly" with a null return. Keeping a null here avoids the bind()
 *   allocation and lets the caller branch cleanly.
 */
function resolveFast(schema: ZodTypeAny): FastValidator | null {
  const native = getNativeAccelerator();
  if (!native?.capabilities.fastValidator) return null;
  let cached = fastCache.get(schema);
  if (!cached) {
    cached = native.compileValidator(schema);
    fastCache.set(schema, cached);
  }
  return cached;
}

/**
 * Run a schema against a value with accumulated errors.
 * Tries the fast path first; on its failure drops to Zod's safeParse so the
 * ZodError issues list populates the caller's errors array with structured
 * field/path/message entries.
 */
function runSchema(
  schema: ZodSchema,
  value: unknown,
  allErrors: FieldError[],
): { ok: true; data: unknown } | { ok: false } {
  const fast = resolveFast(schema);
  if (fast) {
    try {
      return { ok: true, data: fast(value) };
    } catch {
      // Fast path rejected — fall through to Zod for the structured error.
    }
  }
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  allErrors.push(...formatZodErrors(result.error));
  return { ok: false };
}

/** Create validation middleware from Zod schemas */
export function validate(schemas: ValidationSchemas): Middleware {
  return async (c: Context, next) => {
    const allErrors: FieldError[] = [];

    if (schemas.params) {
      const r = runSchema(schemas.params, c.params, allErrors);
      if (r.ok) c.set('validatedParams', r.data);
    }

    if (schemas.query) {
      const r = runSchema(schemas.query, c.queries, allErrors);
      if (r.ok) c.set('validatedQuery', r.data);
    }

    if (schemas.headers) {
      const headerObj: Record<string, string> = {};
      c.req.headers.forEach((v, k) => { headerObj[k] = v; });
      const r = runSchema(schemas.headers, headerObj, allErrors);
      if (r.ok) c.set('validatedHeaders', r.data);
    }

    if (schemas.body) {
      const body = await c.body();
      const r = runSchema(schemas.body, body, allErrors);
      if (r.ok) c.set('validatedBody', r.data);
    }

    if (allErrors.length > 0) {
      throw new VajraValidationError(allErrors);
    }

    return next();
  };
}
