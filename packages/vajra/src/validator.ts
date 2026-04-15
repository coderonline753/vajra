/**
 * Vajra Validator
 * Zod integration for route-level validation with type inference.
 * Throws ValidationError (RSD Route layer error) on failure.
 */

import type { Context } from './context';
import type { Middleware } from './middleware';
import type { ZodSchema, ZodError } from 'zod';
import { ValidationError as VajraValidationError } from './errors';

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

/** Create validation middleware from Zod schemas */
export function validate(schemas: ValidationSchemas): Middleware {
  return async (c: Context, next) => {
    const allErrors: FieldError[] = [];

    if (schemas.params) {
      const result = schemas.params.safeParse(c.params);
      if (!result.success) {
        allErrors.push(...formatZodErrors(result.error));
      } else {
        c.set('validatedParams', result.data);
      }
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(c.queries);
      if (!result.success) {
        allErrors.push(...formatZodErrors(result.error));
      } else {
        c.set('validatedQuery', result.data);
      }
    }

    if (schemas.headers) {
      const headerObj: Record<string, string> = {};
      c.req.headers.forEach((v, k) => { headerObj[k] = v; });
      const result = schemas.headers.safeParse(headerObj);
      if (!result.success) {
        allErrors.push(...formatZodErrors(result.error));
      } else {
        c.set('validatedHeaders', result.data);
      }
    }

    if (schemas.body) {
      const body = await c.body();
      const result = schemas.body.safeParse(body);
      if (!result.success) {
        allErrors.push(...formatZodErrors(result.error));
      } else {
        c.set('validatedBody', result.data);
      }
    }

    if (allErrors.length > 0) {
      throw new VajraValidationError(allErrors);
    }

    return next();
  };
}
