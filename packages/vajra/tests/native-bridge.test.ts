import { describe, test, expect, beforeEach } from 'bun:test';
import { z } from 'zod';
import {
  getNativeAccelerator,
  compileSchemaFast,
  stringifyFast,
  nativeStatus,
} from '../src/native-bridge';

const GLOBAL_KEY = '__vajrajs_native__';

function clearNative() {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g[GLOBAL_KEY];
}

function installFakeNative() {
  const g = globalThis as unknown as Record<string, unknown>;
  g[GLOBAL_KEY] = {
    version: 'fake-1.0.0',
    capabilities: {
      fastValidator: true,
      fastStringify: true,
      fastRouter: false,
      wasm: false,
    },
    compileValidator: (schema: any) => (input: any) => {
      const parsed = schema.parse(input);
      return { ...parsed, __fastPath: true };
    },
    fastStringify: (value: any) => JSON.stringify(value) + '/*fast*/',
  };
}

describe('native-bridge · fallback without @vajrajs/native', () => {
  beforeEach(() => clearNative());

  test('getNativeAccelerator returns undefined', () => {
    expect(getNativeAccelerator()).toBeUndefined();
  });

  test('compileSchemaFast uses Zod standard parse', () => {
    const schema = z.object({ name: z.string() });
    const validate = compileSchemaFast(schema);
    const result = validate({ name: 'Arjun' }) as any;
    expect(result.name).toBe('Arjun');
    expect((result as any).__fastPath).toBeUndefined();
  });

  test('stringifyFast uses standard JSON.stringify', () => {
    const data = { x: 1 };
    expect(stringifyFast(data)).toBe('{"x":1}');
  });

  test('nativeStatus reports pure-ts', () => {
    expect(nativeStatus()).toContain('pure-ts');
  });
});

describe('native-bridge · with fake @vajrajs/native installed', () => {
  beforeEach(() => {
    clearNative();
    installFakeNative();
  });

  test('getNativeAccelerator returns the accelerator', () => {
    const native = getNativeAccelerator();
    expect(native?.version).toBe('fake-1.0.0');
  });

  test('compileSchemaFast uses native validator when available', () => {
    const schema = z.object({ name: z.string() });
    const validate = compileSchemaFast(schema);
    const result = validate({ name: 'Meera' }) as any;
    expect(result.__fastPath).toBe(true);
  });

  test('stringifyFast uses native serializer when available', () => {
    expect(stringifyFast({ x: 1 })).toContain('/*fast*/');
  });

  test('nativeStatus reports native with capabilities', () => {
    const status = nativeStatus();
    expect(status).toContain('fake-1.0.0');
    expect(status).toContain('validator');
    expect(status).toContain('stringify');
  });
});

describe('native-bridge · partial capabilities', () => {
  beforeEach(() => {
    clearNative();
    const g = globalThis as unknown as Record<string, unknown>;
    g[GLOBAL_KEY] = {
      version: '0.1.0',
      capabilities: {
        fastValidator: true,
        fastStringify: false,
        fastRouter: false,
        wasm: false,
      },
      compileValidator: (schema: any) => schema.parse.bind(schema),
      fastStringify: (v: any) => JSON.stringify(v),
    };
  });

  test('stringifyFast falls back when fastStringify capability disabled', () => {
    // Since capability is false, should use plain JSON.stringify (no /*fast*/ marker even if fn exists)
    expect(stringifyFast({ y: 2 })).toBe('{"y":2}');
  });
});
