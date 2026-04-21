import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  createMemoryStorage,
  createLocalStorage,
  createS3Storage,
  verifyLocalSignedUrl,
} from '../src/storage';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const SECRET = 'storage-secret-0123456789';

/* ═════════════ MEMORY STORAGE ═════════════ */

describe('Memory storage', () => {
  test('put and get', async () => {
    const s = createMemoryStorage();
    const data = new TextEncoder().encode('hello');
    await s.put('greeting.txt', data, { contentType: 'text/plain' });

    const result = await s.get('greeting.txt');
    expect(new TextDecoder().decode(result.body)).toBe('hello');
    expect(result.contentType).toBe('text/plain');
    expect(result.size).toBe(5);
  });

  test('exists and delete', async () => {
    const s = createMemoryStorage();
    await s.put('x.bin', new Uint8Array([1, 2, 3]));
    expect(await s.exists('x.bin')).toBe(true);
    await s.delete('x.bin');
    expect(await s.exists('x.bin')).toBe(false);
  });

  test('stat returns metadata', async () => {
    const s = createMemoryStorage();
    const body = new TextEncoder().encode('hi');
    await s.put('file.txt', body, {
      contentType: 'text/plain',
      metadata: { owner: 'alice' },
    });
    const stat = await s.stat('file.txt');
    expect(stat.size).toBe(2);
    expect(stat.contentType).toBe('text/plain');
    expect(stat.metadata.owner).toBe('alice');
  });

  test('list with prefix', async () => {
    const s = createMemoryStorage();
    await s.put('users/a.json', new Uint8Array([1]));
    await s.put('users/b.json', new Uint8Array([2]));
    await s.put('posts/c.json', new Uint8Array([3]));

    const result = await s.list({ prefix: 'users/' });
    expect(result.keys.length).toBe(2);
    expect(result.keys).toContain('users/a.json');
    expect(result.keys).toContain('users/b.json');
  });

  test('list pagination via cursor', async () => {
    const s = createMemoryStorage();
    for (let i = 0; i < 5; i++) await s.put(`item_${i}`, new Uint8Array([i]));

    const page1 = await s.list({ limit: 2 });
    expect(page1.keys.length).toBe(2);
    expect(page1.cursor).not.toBeNull();

    const page2 = await s.list({ limit: 2, cursor: page1.cursor! });
    expect(page2.keys.length).toBe(2);
    expect(page2.keys[0]).not.toBe(page1.keys[0]);
  });

  test('get throws for missing key', () => {
    const s = createMemoryStorage();
    expect(s.get('ghost')).rejects.toThrow(/Not found/);
  });

  test('rejects path traversal', async () => {
    const s = createMemoryStorage();
    expect(s.put('../../etc/passwd', new Uint8Array([1]))).rejects.toThrow(/path traversal/);
  });

  test('signUrl requires secret', () => {
    const s = createMemoryStorage();
    expect(s.signUrl('x.txt')).rejects.toThrow(/urlSecret required/);
  });

  test('signUrl generates signed URL', async () => {
    const s = createMemoryStorage(SECRET);
    await s.put('doc.pdf', new Uint8Array([1, 2, 3]));
    const url = await s.signUrl('doc.pdf', { expiresIn: 60 });
    expect(url).toContain('memory://doc.pdf');
    expect(url).toContain('sig=');
  });

  test('stream body accepted', async () => {
    const s = createMemoryStorage();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('part1'));
        c.enqueue(new TextEncoder().encode('part2'));
        c.close();
      },
    });
    await s.put('stream.txt', stream);
    const result = await s.get('stream.txt');
    expect(new TextDecoder().decode(result.body)).toBe('part1part2');
  });
});

/* ═════════════ LOCAL STORAGE ═════════════ */

describe('Local storage', () => {
  let tempRoot: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(tmpdir() + '/vajra-storage-test-');
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('put and get', async () => {
    const s = createLocalStorage({ root: tempRoot });
    await s.put('a.txt', new TextEncoder().encode('hello'), { contentType: 'text/plain' });

    const result = await s.get('a.txt');
    expect(new TextDecoder().decode(result.body)).toBe('hello');
  });

  test('creates nested directories', async () => {
    const s = createLocalStorage({ root: tempRoot });
    await s.put('deep/nested/file.bin', new Uint8Array([1, 2, 3]));
    expect(await s.exists('deep/nested/file.bin')).toBe(true);
  });

  test('delete removes file', async () => {
    const s = createLocalStorage({ root: tempRoot });
    await s.put('del.txt', new Uint8Array([0]));
    expect(await s.exists('del.txt')).toBe(true);
    await s.delete('del.txt');
    expect(await s.exists('del.txt')).toBe(false);
  });

  test('stat returns file size', async () => {
    const s = createLocalStorage({ root: tempRoot });
    const body = new TextEncoder().encode('1234567890');
    await s.put('sized.txt', body);
    const stat = await s.stat('sized.txt');
    expect(stat.size).toBe(10);
  });

  test('list enumerates files', async () => {
    const s = createLocalStorage({ root: tempRoot });
    await s.put('list/one.txt', new Uint8Array([1]));
    await s.put('list/two.txt', new Uint8Array([2]));
    const result = await s.list({ prefix: 'list/' });
    expect(result.keys.some((k) => k.endsWith('one.txt'))).toBe(true);
    expect(result.keys.some((k) => k.endsWith('two.txt'))).toBe(true);
  });

  test('signUrl requires secret', () => {
    const s = createLocalStorage({ root: tempRoot });
    expect(s.signUrl('x.txt')).rejects.toThrow(/urlSecret required/);
  });

  test('signUrl + verifyLocalSignedUrl roundtrip', async () => {
    const s = createLocalStorage({
      root: tempRoot,
      urlSecret: SECRET,
      publicBaseUrl: 'https://cdn.example.com/files',
    });
    await s.put('report.pdf', new Uint8Array([1, 2, 3]));
    const url = await s.signUrl('report.pdf', { expiresIn: 60 });
    expect(url).toContain('https://cdn.example.com/files/report.pdf');

    const verification = await verifyLocalSignedUrl(url, SECRET);
    expect(verification.valid).toBe(true);
    expect(verification.key).toBe('report.pdf');
    expect(verification.method).toBe('GET');
  });

  test('verifyLocalSignedUrl rejects expired URLs', async () => {
    const s = createLocalStorage({
      root: tempRoot,
      urlSecret: SECRET,
      publicBaseUrl: 'https://cdn.example.com/files',
    });
    const url = await s.signUrl('expired.txt', { expiresIn: -1 });
    const v = await verifyLocalSignedUrl(url, SECRET);
    expect(v.valid).toBe(false);
  });

  test('verifyLocalSignedUrl rejects wrong secret', async () => {
    const s = createLocalStorage({
      root: tempRoot,
      urlSecret: SECRET,
      publicBaseUrl: 'https://cdn.example.com/files',
    });
    const url = await s.signUrl('x.txt');
    const v = await verifyLocalSignedUrl(url, 'different-secret');
    expect(v.valid).toBe(false);
  });
});

/* ═════════════ S3 STORAGE (fake client) ═════════════ */

describe('S3-compatible storage', () => {
  function fakeS3() {
    const store = new Map<string, { body: Uint8Array; contentType?: string; metadata?: Record<string, string>; modifiedAt: Date }>();

    const client = {
      async send(cmd: any) {
        if (cmd.op === 'put') {
          store.set(cmd.Key, {
            body: cmd.Body,
            contentType: cmd.ContentType,
            metadata: cmd.Metadata,
            modifiedAt: new Date(),
          });
          return {};
        }
        if (cmd.op === 'get') {
          const entry = store.get(cmd.Key);
          if (!entry) throw new Error('NoSuchKey');
          return {
            Body: { transformToByteArray: async () => entry.body },
            ContentType: entry.contentType,
            Metadata: entry.metadata ?? {},
          };
        }
        if (cmd.op === 'delete') { store.delete(cmd.Key); return {}; }
        if (cmd.op === 'head') {
          const entry = store.get(cmd.Key);
          if (!entry) throw new Error('NotFound');
          return {
            ContentLength: entry.body.length,
            ContentType: entry.contentType,
            LastModified: entry.modifiedAt,
            Metadata: entry.metadata ?? {},
          };
        }
        if (cmd.op === 'list') {
          const prefix = cmd.Prefix ?? '';
          const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
          return { Contents: keys.map((k) => ({ Key: k })), NextContinuationToken: null };
        }
      },
    };

    const factory = {
      put: (args: any) => ({ op: 'put', ...args }),
      get: (args: any) => ({ op: 'get', ...args }),
      delete: (args: any) => ({ op: 'delete', ...args }),
      head: (args: any) => ({ op: 'head', ...args }),
      list: (args: any) => ({ op: 'list', ...args }),
    };

    return { client, factory };
  }

  test('put/get via fake S3', async () => {
    const { client, factory } = fakeS3();
    const s = createS3Storage({ bucket: 'test-bucket', client, commandFactory: factory });

    await s.put('hello.txt', new TextEncoder().encode('world'), { contentType: 'text/plain' });
    const result = await s.get('hello.txt');
    expect(new TextDecoder().decode(result.body)).toBe('world');
    expect(result.contentType).toBe('text/plain');
  });

  test('exists + delete', async () => {
    const { client, factory } = fakeS3();
    const s = createS3Storage({ bucket: 'b', client, commandFactory: factory });
    await s.put('x.bin', new Uint8Array([1]));
    expect(await s.exists('x.bin')).toBe(true);
    await s.delete('x.bin');
    expect(await s.exists('x.bin')).toBe(false);
  });

  test('list via fake S3', async () => {
    const { client, factory } = fakeS3();
    const s = createS3Storage({ bucket: 'b', client, commandFactory: factory });
    await s.put('prefix/a', new Uint8Array([1]));
    await s.put('prefix/b', new Uint8Array([2]));
    await s.put('other/c', new Uint8Array([3]));
    const r = await s.list({ prefix: 'prefix/' });
    expect(r.keys.length).toBe(2);
  });

  test('signUrl with presign function', async () => {
    const { client, factory } = fakeS3();
    const s = createS3Storage({
      bucket: 'b',
      client,
      commandFactory: factory,
      presign: async (key, exp, method) => `https://presigned.example.com/${key}?X-Amz-Expires=${exp}&method=${method}`,
    });
    const url = await s.signUrl('file.jpg', { expiresIn: 300 });
    expect(url).toContain('presigned.example.com/file.jpg');
    expect(url).toContain('X-Amz-Expires=300');
  });

  test('signUrl falls back to publicBaseUrl', async () => {
    const { client, factory } = fakeS3();
    const s = createS3Storage({
      bucket: 'b',
      client,
      commandFactory: factory,
      publicBaseUrl: 'https://cdn.example.com/b',
    });
    const url = await s.signUrl('file.jpg');
    expect(url).toBe('https://cdn.example.com/b/file.jpg');
  });
});
