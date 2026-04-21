/**
 * Vajra Native Bridge
 * Auto-detects @vajrajs/native if installed. Pure-TS fallback when absent.
 *
 * Users opt into acceleration by running:
 *   bun add @vajrajs/native
 *   // then in app bootstrap:
 *   import { registerNativeAcceleration } from '@vajrajs/native';
 *   registerNativeAcceleration();
 *
 * All Vajra hot paths check `getNativeAccelerator()` at runtime. When present,
 * they use the accelerated implementations. When absent, pure-TS fallback.
 */

import type { ZodTypeAny } from 'zod';

const GLOBAL_KEY = '__vajrajs_native__';

export interface NativeAccelerator {
  version: string;
  capabilities: {
    fastValidator: boolean;
    fastStringify: boolean;
    fastRouter: boolean;
    wasm: boolean;
  };
  compileValidator<T extends ZodTypeAny>(schema: T): (input: unknown) => unknown;
  fastStringify<T>(value: T, schema?: ZodTypeAny): string;
}

/**
 * Look up the native accelerator if registered.
 * Returns undefined when pure-TS mode is active.
 */
export function getNativeAccelerator(): NativeAccelerator | undefined {
  const g = globalThis as unknown as { [GLOBAL_KEY]?: NativeAccelerator };
  return g[GLOBAL_KEY];
}

/**
 * Compile a Zod schema to a fast validator, using native acceleration if available.
 * Falls back to standard Zod .parse() when native is absent.
 */
export function compileSchemaFast<T extends ZodTypeAny>(schema: T): (input: unknown) => unknown {
  const native = getNativeAccelerator();
  if (native?.capabilities.fastValidator) {
    return native.compileValidator(schema);
  }
  return schema.parse.bind(schema);
}

type FastValidator = (input: unknown) => unknown;
const fastParseCache = new WeakMap<ZodTypeAny, FastValidator>();

/**
 * Drop-in fast equivalent of `schema.parse(value)`.
 *
 * Tries the native compiled validator first when available. On any throw
 * from the fast path, re-runs `schema.parse()` so the caller always sees a
 * proper ZodError (with issue list) rather than a generic TypeError.
 *
 * Cached per schema reference.
 */
export function fastParse<T extends ZodTypeAny>(schema: T, value: unknown): unknown {
  const native = getNativeAccelerator();
  if (native?.capabilities.fastValidator) {
    let validator = fastParseCache.get(schema);
    if (!validator) {
      validator = native.compileValidator(schema);
      fastParseCache.set(schema, validator);
    }
    try {
      return validator(value);
    } catch {
      // Fall through to Zod so the caller gets a structured ZodError.
      return schema.parse(value);
    }
  }
  return schema.parse(value);
}

/**
 * Stringify JSON using native acceleration if available.
 */
export function stringifyFast<T>(value: T, schema?: ZodTypeAny): string {
  const native = getNativeAccelerator();
  if (native?.capabilities.fastStringify) {
    return native.fastStringify(value, schema);
  }
  return JSON.stringify(value);
}

/**
 * Human-readable status line for logs / dev playground.
 */
export function nativeStatus(): string {
  const native = getNativeAccelerator();
  if (!native) return 'pure-ts (native accelerator not installed)';
  const caps = native.capabilities;
  const enabled = [];
  if (caps.fastValidator) enabled.push('validator');
  if (caps.fastStringify) enabled.push('stringify');
  if (caps.fastRouter) enabled.push('router');
  if (caps.wasm) enabled.push('wasm');
  return `@vajrajs/native@${native.version} [${enabled.join(',') || 'none'}]`;
}
