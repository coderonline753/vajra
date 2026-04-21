import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { z } from 'zod';
import {
  Vajra,
  validate,
  fastParse,
  getNativeAccelerator,
  defineContract,
  contractRouter,
  nativeStatus,
} from '../src/index';

/**
 * These tests exercise the native-accelerator bridge by registering a stub
 * accelerator directly on globalThis (the same path @vajrajs/native uses).
 * The stub proves the integration wiring — the actual shape-compiled
 * validator lives in the separate package and has its own test suite.
 */

const GLOBAL_KEY = '__vajrajs_native__';

function installStubAccelerator(opts: { calls: { compile: number; fast: number } }) {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
    version: 'test-0.0.0',
    capabilities: { fastValidator: true, fastStringify: false, fastRouter: false, wasm: false },
    compileValidator: (schema: z.ZodTypeAny) => {
      opts.calls.compile++;
      return (input: unknown) => {
        opts.calls.fast++;
        // Stub just forwards to Zod parse. Real accelerator would specialize.
        return schema.parse(input);
      };
    },
    fastStringify: <T>(v: T) => JSON.stringify(v),
  };
}

function uninstallStub() {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}

describe('native-bridge · getNativeAccelerator + nativeStatus', () => {
  beforeEach(() => uninstallStub());
  afterEach(() => uninstallStub());

  test('returns undefined when not registered', () => {
    expect(getNativeAccelerator()).toBeUndefined();
    expect(nativeStatus()).toContain('pure-ts');
  });

  test('returns accelerator when registered, status reflects capabilities', () => {
    const calls = { compile: 0, fast: 0 };
    installStubAccelerator({ calls });
    const native = getNativeAccelerator();
    expect(native).toBeDefined();
    expect(native?.capabilities.fastValidator).toBe(true);
    expect(nativeStatus()).toContain('test-0.0.0');
    expect(nativeStatus()).toContain('validator');
  });
});

describe('fastParse · native path vs fallback', () => {
  beforeEach(() => uninstallStub());
  afterEach(() => uninstallStub());

  test('falls back to schema.parse when native is absent', () => {
    const schema = z.object({ n: z.number() });
    const result = fastParse(schema, { n: 42 });
    expect(result).toEqual({ n: 42 });
  });

  test('uses native compileValidator when registered', () => {
    const calls = { compile: 0, fast: 0 };
    installStubAccelerator({ calls });
    const schema = z.object({ n: z.number() });

    fastParse(schema, { n: 1 });
    expect(calls.compile).toBe(1);
    expect(calls.fast).toBe(1);

    // Second call reuses cached validator (no re-compile)
    fastParse(schema, { n: 2 });
    expect(calls.compile).toBe(1);
    expect(calls.fast).toBe(2);
  });

  test('falls back to schema.parse when native path throws a TypeError', () => {
    const calls = { compile: 0, fast: 0 };
    // Install a stub whose validator always throws non-ZodError
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
      version: 'throws',
      capabilities: { fastValidator: true, fastStringify: false, fastRouter: false, wasm: false },
      compileValidator: () => {
        calls.compile++;
        return () => {
          calls.fast++;
          throw new TypeError('fast path rejected');
        };
      },
      fastStringify: <T>(v: T) => JSON.stringify(v),
    };

    const schema = z.object({ n: z.number() });
    // Valid input: fast rejects, fallback Zod accepts
    const result = fastParse(schema, { n: 42 });
    expect(result).toEqual({ n: 42 });
    expect(calls.fast).toBe(1);

    // Invalid input: fast rejects, fallback Zod also rejects with ZodError
    expect(() => fastParse(schema, { n: 'wrong' })).toThrow();
  });
});

describe('validate middleware · native accelerator integration', () => {
  beforeEach(() => uninstallStub());
  afterEach(() => uninstallStub());

  test('validates body via native fast path when registered', async () => {
    const calls = { compile: 0, fast: 0 };
    installStubAccelerator({ calls });

    const app = new Vajra();
    app.use(validate({ body: z.object({ name: z.string() }) }));
    app.post('/u', (c) => c.json({ got: c.get('validatedBody') }));

    const res = await app.handle(new Request('http://localhost/u', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rahul' }),
    }));
    expect(res.status).toBe(200);
    expect(calls.fast).toBeGreaterThanOrEqual(1);
  });

  test('validation errors still return structured multi-error response', async () => {
    const calls = { compile: 0, fast: 0 };
    installStubAccelerator({ calls });

    const app = new Vajra();
    app.use(validate({
      body: z.object({ name: z.string(), age: z.number() }),
    }));
    app.post('/u', (c) => c.json({ ok: true }));

    const res = await app.handle(new Request('http://localhost/u', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 123, age: 'bad' }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as {
      success: boolean;
      error: { code: string; details: { fields: Array<{ field: string }> } };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    // Both field errors accumulated (Zod safeParse fallback preserves issue list)
    expect(body.error.details.fields.length).toBe(2);
    const fields = body.error.details.fields.map(f => f.field).sort();
    expect(fields).toEqual(['age', 'name']);
  });

  test('identical behavior with and without accelerator (happy path)', async () => {
    async function run(withNative: boolean) {
      if (withNative) {
        const calls = { compile: 0, fast: 0 };
        installStubAccelerator({ calls });
      } else {
        uninstallStub();
      }
      const app = new Vajra();
      app.use(validate({ query: z.object({ q: z.string() }) }));
      app.get('/s', (c) => c.json({ q: c.get('validatedQuery') }));
      const res = await app.handle(new Request('http://localhost/s?q=hello'));
      return { status: res.status, body: await res.json() };
    }
    const off = await run(false);
    const on = await run(true);
    expect(on).toEqual(off);
  });
});

describe('contractRouter · native accelerator integration', () => {
  beforeEach(() => uninstallStub());
  afterEach(() => uninstallStub());

  test('server-side contract parse uses fast path when registered', async () => {
    const calls = { compile: 0, fast: 0 };
    installStubAccelerator({ calls });

    const contract = defineContract({
      createUser: {
        method: 'POST' as const,
        path: '/users',
        body: z.object({ name: z.string() }),
        response: z.object({ id: z.number(), name: z.string() }),
      },
    });

    const app = new Vajra();
    const routes = contractRouter(contract, {
      createUser: async ({ body }) => ({ id: 1, name: body.name }),
    });
    for (const r of routes) app.post(r.path, r.handler);

    const res = await app.handle(new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A' }),
    }));
    expect(res.status).toBe(200);
    // Body + response both routed through fastParse
    expect(calls.fast).toBeGreaterThanOrEqual(2);
  });
});
