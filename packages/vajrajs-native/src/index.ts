/**
 * @vajrajs/native — Optional pure-TS acceleration for Vajra.
 *
 * Install alongside vajrajs to get faster Zod validation for common object
 * schemas. No build step, no WASM in v0.1 — just hand-written shape compilers
 * that skip Zod's polymorphic dispatch on every call.
 *
 *   bun add @vajrajs/native
 *   // at app startup:
 *   import { registerNativeAcceleration } from '@vajrajs/native';
 *   registerNativeAcceleration();
 *
 * Vajra core auto-detects this registration. Fallback to plain Zod is always
 * safe if this package is absent.
 *
 * v0.1 scope (this release): shape-compiled validators for
 *   - z.string / z.number / z.boolean / z.null
 *   - z.object of the above primitives (1-level shape)
 *   - z.array of primitives
 *   - any other schema type falls back to the original schema.parse()
 *
 * v0.2 planned: AssemblyScript WASM backend for deep objects + regex pre-compile.
 * v0.3 planned: fast JSON stringify with shape-known paths.
 */

import type { ZodTypeAny } from 'zod';

/* ═════════════ TYPES ═════════════ */

type Validator = (input: unknown) => unknown;

interface ZodRuntime {
  _def: {
    typeName?: string;
    shape?: (() => Record<string, ZodTypeAny>) | Record<string, ZodTypeAny>;
    type?: ZodTypeAny;
    innerType?: ZodTypeAny;
    checks?: Array<{ kind: string; value?: unknown }>;
  };
}

function readDef(schema: ZodTypeAny): ZodRuntime['_def'] {
  return (schema as unknown as ZodRuntime)._def;
}

/* ═════════════ SHAPE COMPILER ═════════════ */

/**
 * Compile a Zod schema into a specialized validator that skips Zod's generic
 * dispatch on every call. Returns a function that throws if input is invalid
 * (same contract as schema.parse()).
 *
 * If the schema shape cannot be shape-compiled (e.g. it has refinements,
 * transforms, unions, or deep objects), falls back to schema.parse bound.
 */
function compileShape(schema: ZodTypeAny): Validator | null {
  const def = readDef(schema);
  const name = def.typeName;

  switch (name) {
    case 'ZodString': {
      const checks = def.checks ?? [];
      if (checks.length === 0) {
        return (input: unknown) => {
          if (typeof input !== 'string') throw new TypeError('Expected string');
          return input;
        };
      }
      // Schemas with min/max/email/etc fall back — Zod's full check chain.
      return null;
    }
    case 'ZodNumber': {
      const checks = def.checks ?? [];
      if (checks.length === 0) {
        return (input: unknown) => {
          if (typeof input !== 'number' || Number.isNaN(input)) throw new TypeError('Expected number');
          return input;
        };
      }
      return null;
    }
    case 'ZodBoolean':
      return (input: unknown) => {
        if (typeof input !== 'boolean') throw new TypeError('Expected boolean');
        return input;
      };
    case 'ZodNull':
      return (input: unknown) => {
        if (input !== null) throw new TypeError('Expected null');
        return input;
      };
    case 'ZodArray': {
      const inner = def.type;
      if (!inner) return null;
      const innerValidator = compileShape(inner);
      if (!innerValidator) return null;
      return (input: unknown) => {
        if (!Array.isArray(input)) throw new TypeError('Expected array');
        const out = new Array(input.length);
        for (let i = 0; i < input.length; i++) out[i] = innerValidator(input[i]);
        return out;
      };
    }
    case 'ZodObject': {
      const shapeSrc = def.shape;
      const shape = typeof shapeSrc === 'function' ? shapeSrc() : shapeSrc;
      if (!shape || typeof shape !== 'object') return null;
      const entries: Array<[string, Validator]> = [];
      for (const [key, child] of Object.entries(shape)) {
        const childValidator = compileShape(child);
        if (!childValidator) return null; // one unknown → bail whole object
        entries.push([key, childValidator]);
      }
      // Pre-built array of [key, validator] — walked per call, no dispatch.
      return (input: unknown) => {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new TypeError('Expected object');
        }
        const src = input as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (let i = 0; i < entries.length; i++) {
          const [k, v] = entries[i];
          out[k] = v(src[k]);
        }
        return out;
      };
    }
    default:
      return null; // Unions, refinements, optionals, transforms, etc.
  }
}

/* ═════════════ PUBLIC API ═════════════ */

const validatorCache = new WeakMap<ZodTypeAny, Validator>();

/**
 * Compile a Zod schema to a cached validator.
 *
 * Returns a shape-specialized function when the schema is shape-compilable,
 * otherwise returns `schema.parse` bound to the schema (pure Zod behavior).
 * Result is WeakMap-cached per schema reference.
 */
export function compileValidator<T extends ZodTypeAny>(schema: T): (input: unknown) => unknown {
  let cached = validatorCache.get(schema);
  if (!cached) {
    cached = compileShape(schema) ?? schema.parse.bind(schema);
    validatorCache.set(schema, cached);
  }
  return cached;
}

/**
 * Fast JSON stringify. v0.1 defers to JSON.stringify (no gain over plain);
 * v0.3 will add shape-compiled serializers for known Zod response schemas.
 */
export function fastStringify<T>(value: T, _schema?: ZodTypeAny): string {
  return JSON.stringify(value);
}

/* ═════════════ REGISTRATION ═════════════ */

export const VAJRA_NATIVE_VERSION = '0.1.0' as const;
export const VAJRA_NATIVE_CAPABILITIES = {
  fastValidator: true,   // shape-compiled (no WASM yet)
  fastStringify: false,  // v0.3
  fastRouter: false,     // v0.2
  wasm: false,           // v0.2
} as const;

const GLOBAL_KEY = '__vajrajs_native__';

/**
 * Register this package's capabilities on globalThis. Vajra core checks for
 * this registration at startup. Call once from app bootstrap.
 */
export function registerNativeAcceleration(): void {
  const g = globalThis as unknown as { [GLOBAL_KEY]?: unknown };
  g[GLOBAL_KEY] = {
    version: VAJRA_NATIVE_VERSION,
    capabilities: VAJRA_NATIVE_CAPABILITIES,
    compileValidator,
    fastStringify,
  };
}

/** Check if native acceleration is registered on the current globalThis. */
export function isNativeRegistered(): boolean {
  const g = globalThis as unknown as { [GLOBAL_KEY]?: unknown };
  return g[GLOBAL_KEY] != null;
}
