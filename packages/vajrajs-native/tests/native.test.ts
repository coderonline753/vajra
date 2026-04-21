import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import {
  compileValidator,
  fastStringify,
  registerNativeAcceleration,
  isNativeRegistered,
  VAJRA_NATIVE_VERSION,
  VAJRA_NATIVE_CAPABILITIES,
} from '../src/index';

describe('@vajrajs/native · compileValidator', () => {
  test('object of primitives returns valid input', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const validate = compileValidator(schema);
    const result = validate({ name: 'Rahul', age: 31 }) as { name: string; age: number };
    expect(result.name).toBe('Rahul');
    expect(result.age).toBe(31);
  });

  test('object validator rejects wrong field type', () => {
    const schema = z.object({ x: z.string() });
    const validate = compileValidator(schema);
    expect(() => validate({ x: 123 })).toThrow();
  });

  test('object validator rejects non-object input', () => {
    const schema = z.object({ x: z.string() });
    const validate = compileValidator(schema);
    expect(() => validate('not an object')).toThrow();
    expect(() => validate(null)).toThrow();
    expect(() => validate([1, 2, 3])).toThrow();
  });

  test('string primitive validator accepts strings only', () => {
    const validate = compileValidator(z.string());
    expect(validate('hello')).toBe('hello');
    expect(() => validate(42)).toThrow();
  });

  test('number primitive validator rejects NaN', () => {
    const validate = compileValidator(z.number());
    expect(validate(3.14)).toBe(3.14);
    expect(() => validate(NaN)).toThrow();
    expect(() => validate('42')).toThrow();
  });

  test('boolean primitive validator works', () => {
    const validate = compileValidator(z.boolean());
    expect(validate(true)).toBe(true);
    expect(validate(false)).toBe(false);
    expect(() => validate(1)).toThrow();
  });

  test('array of numbers validator', () => {
    const schema = z.array(z.number());
    const validate = compileValidator(schema);
    expect(validate([1, 2, 3])).toEqual([1, 2, 3]);
    expect(() => validate([1, 'two', 3])).toThrow();
    expect(() => validate('not array')).toThrow();
  });

  test('array of strings validator', () => {
    const schema = z.array(z.string());
    const validate = compileValidator(schema);
    expect(validate(['a', 'b'])).toEqual(['a', 'b']);
  });

  test('schema with string min-length falls back to Zod parse', () => {
    const schema = z.string().min(5);
    const validate = compileValidator(schema);
    expect(validate('hello')).toBe('hello');
    expect(() => validate('hi')).toThrow();
  });

  test('schema with email format falls back to Zod', () => {
    const schema = z.string().email();
    const validate = compileValidator(schema);
    expect(validate('ashish@example.com')).toBe('ashish@example.com');
    expect(() => validate('not-an-email')).toThrow();
  });

  test('union schema falls back to Zod parse', () => {
    const schema = z.union([z.string(), z.number()]);
    const validate = compileValidator(schema);
    expect(validate('str')).toBe('str');
    expect(validate(42)).toBe(42);
    expect(() => validate(true)).toThrow();
  });

  test('object containing constrained inner field falls back and still validates', () => {
    const schema = z.object({
      id: z.number(),
      note: z.string().min(1),
    });
    const validate = compileValidator(schema);
    expect(validate({ id: 1, note: 'hi' })).toEqual({ id: 1, note: 'hi' });
    expect(() => validate({ id: 1, note: '' })).toThrow();
  });

  test('caches validator by schema reference', () => {
    const schema = z.string();
    const v1 = compileValidator(schema);
    const v2 = compileValidator(schema);
    expect(v1).toBe(v2);
  });

  test('produces same output shape as schema.parse for compiled objects', () => {
    const schema = z.object({ a: z.number(), b: z.string(), c: z.boolean() });
    const input = { a: 1, b: 'x', c: true };
    const zodOut = schema.parse(input);
    const nativeOut = compileValidator(schema)(input);
    expect(nativeOut).toEqual(zodOut);
  });

  test('compiled object drops extra keys (matches Zod default)', () => {
    const schema = z.object({ a: z.number() });
    const validate = compileValidator(schema);
    const result = validate({ a: 1, extra: 'ignored' }) as Record<string, unknown>;
    expect(result.a).toBe(1);
    expect(result.extra).toBeUndefined();
  });
});

describe('@vajrajs/native · fastStringify', () => {
  test('stringifies primitive objects', () => {
    expect(fastStringify({ x: 1 })).toBe('{"x":1}');
  });

  test('matches JSON.stringify output', () => {
    const v = { a: 1, b: [2, 3], c: { d: 'e' } };
    expect(fastStringify(v)).toBe(JSON.stringify(v));
  });

  test('accepts optional schema arg without using it (v0.1 no-op)', () => {
    const schema = z.object({ x: z.number() });
    expect(fastStringify({ x: 1 }, schema)).toBe('{"x":1}');
  });
});

describe('@vajrajs/native · registration', () => {
  test('VAJRA_NATIVE_VERSION is 0.1.0', () => {
    expect(VAJRA_NATIVE_VERSION).toBe('0.1.0');
  });

  test('capabilities reflect v0.1 scope', () => {
    expect(VAJRA_NATIVE_CAPABILITIES.fastValidator).toBe(true);
    expect(VAJRA_NATIVE_CAPABILITIES.fastStringify).toBe(false);
    expect(VAJRA_NATIVE_CAPABILITIES.fastRouter).toBe(false);
    expect(VAJRA_NATIVE_CAPABILITIES.wasm).toBe(false);
  });

  test('registerNativeAcceleration sets the global marker', () => {
    delete (globalThis as Record<string, unknown>)['__vajrajs_native__'];
    expect(isNativeRegistered()).toBe(false);
    registerNativeAcceleration();
    expect(isNativeRegistered()).toBe(true);
  });
});
