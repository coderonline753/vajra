import { describe, test, expect } from 'bun:test';
import { detectFormat, generateSrcset, generateCacheKey } from '../src/image';

describe('Image Module', () => {
  test('detects JPEG magic bytes', () => {
    const header = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(detectFormat(header)).toBe('jpeg');
  });

  test('detects PNG magic bytes', () => {
    const header = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
    expect(detectFormat(header)).toBe('png');
  });

  test('detects GIF magic bytes', () => {
    const header = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
    expect(detectFormat(header)).toBe('gif');
  });

  test('returns null for unknown format', () => {
    const header = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(detectFormat(header)).toBeNull();
  });

  test('generates srcset string', () => {
    const srcset = generateSrcset('/images/hero.jpg', [320, 640, 1024]);
    expect(srcset).toContain('/images/hero.jpg?w=320&format=webp 320w');
    expect(srcset).toContain('/images/hero.jpg?w=640&format=webp 640w');
    expect(srcset).toContain('/images/hero.jpg?w=1024&format=webp 1024w');
  });

  test('generates deterministic cache key', () => {
    const key1 = generateCacheKey('photo.jpg', { width: 300, format: 'webp' });
    const key2 = generateCacheKey('photo.jpg', { width: 300, format: 'webp' });
    const key3 = generateCacheKey('photo.jpg', { width: 400, format: 'webp' });
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });

  test('cache key is 64 char hex (SHA-256)', () => {
    const key = generateCacheKey('test.jpg', { width: 100 });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});
