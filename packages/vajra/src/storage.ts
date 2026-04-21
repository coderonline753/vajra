/**
 * Vajra Storage Module
 * Pluggable storage adapter · local filesystem, S3/B2-compatible, in-memory (tests).
 *
 * const storage = createLocalStorage({ root: '/var/data/uploads' });
 * await storage.put('avatars/1.jpg', bytes, { contentType: 'image/jpeg' });
 * const url = await storage.signUrl('avatars/1.jpg', { expiresIn: 3600 });
 */

import { sign, unsign } from './session';

/* ═════════════ INTERFACE ═════════════ */

export interface PutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  cacheControl?: string;
  /** Additional custom properties the driver may support */
  [key: string]: unknown;
}

export interface GetResult {
  body: Uint8Array;
  contentType: string | null;
  size: number;
  metadata: Record<string, string>;
}

export interface StatResult {
  size: number;
  contentType: string | null;
  modifiedAt: Date;
  metadata: Record<string, string>;
}

export interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface ListResult {
  keys: string[];
  cursor: string | null;
}

export interface SignUrlOptions {
  /** URL expiry in seconds. Default: 3600 */
  expiresIn?: number;
  /** HTTP method the URL authorizes. Default: 'GET' */
  method?: 'GET' | 'PUT';
  /** Optional response content-disposition override */
  contentDisposition?: string;
}

export interface StorageAdapter {
  readonly driver: string;
  put(key: string, data: Uint8Array | ReadableStream, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<GetResult>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<StatResult>;
  list(opts?: ListOptions): Promise<ListResult>;
  signUrl(key: string, opts?: SignUrlOptions): Promise<string>;
}

/* ═════════════ LOCAL FS DRIVER ═════════════ */

export interface LocalStorageOptions {
  /** Root directory (absolute path) */
  root: string;
  /** Base URL prefix for signUrl (e.g., 'https://cdn.example.com/files') */
  publicBaseUrl?: string;
  /** HMAC secret for signed URLs */
  urlSecret?: string;
}

export function createLocalStorage(opts: LocalStorageOptions): StorageAdapter {
  const root = opts.root.replace(/\/+$/, '');

  const resolveKey = (key: string): string => {
    const clean = sanitizeKey(key);
    return `${root}/${clean}`;
  };

  const loadFs = async () => {
    const fs = await import('node:fs/promises');
    return fs;
  };

  return {
    driver: 'local',

    async put(key, data, putOpts) {
      const path = resolveKey(key);
      const fs = await loadFs();
      await fs.mkdir(dirOf(path), { recursive: true });
      if (data instanceof Uint8Array) {
        await Bun.write(path, data);
      } else {
        // Stream — write to temp, then rename for atomicity
        const tempPath = `${path}.tmp${Date.now()}`;
        const writer = Bun.file(tempPath).writer();
        const reader = (data as ReadableStream<Uint8Array>).getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writer.write(value);
          }
          await writer.end();
          await fs.rename(tempPath, path);
        } catch (err) {
          try { await fs.unlink(tempPath); } catch { /* ignore */ }
          throw err;
        }
      }
      if (putOpts?.metadata) {
        await fs.writeFile(`${path}.meta.json`, JSON.stringify({
          contentType: putOpts.contentType ?? null,
          metadata: putOpts.metadata ?? {},
        }));
      }
    },

    async get(key) {
      const path = resolveKey(key);
      const body = new Uint8Array(await Bun.file(path).arrayBuffer());
      const metaPath = `${path}.meta.json`;
      let contentType: string | null = null;
      let metadata: Record<string, string> = {};
      try {
        const meta = JSON.parse(await Bun.file(metaPath).text());
        contentType = meta.contentType ?? null;
        metadata = meta.metadata ?? {};
      } catch { /* no meta */ }
      return { body, contentType, size: body.length, metadata };
    },

    async delete(key) {
      const path = resolveKey(key);
      const fs = await loadFs();
      try { await fs.unlink(path); } catch { /* ignore missing */ }
      try { await fs.unlink(`${path}.meta.json`); } catch { /* ignore */ }
    },

    async exists(key) {
      return await Bun.file(resolveKey(key)).exists();
    },

    async stat(key) {
      const path = resolveKey(key);
      const fs = await loadFs();
      const s = await fs.stat(path);
      const metaPath = `${path}.meta.json`;
      let contentType: string | null = null;
      let metadata: Record<string, string> = {};
      try {
        const meta = JSON.parse(await Bun.file(metaPath).text());
        contentType = meta.contentType ?? null;
        metadata = meta.metadata ?? {};
      } catch { /* no meta */ }
      return { size: s.size, contentType, modifiedAt: s.mtime, metadata };
    },

    async list(listOpts = {}) {
      const fs = await loadFs();
      const prefix = sanitizeKey(listOpts.prefix ?? '');
      const base = prefix ? `${root}/${prefix}` : root;
      const entries: string[] = [];
      await walkDir(fs, base, entries, root);
      const filtered = entries
        .filter((k) => !prefix || k.startsWith(prefix))
        .filter((k) => !k.endsWith('.meta.json'))
        .sort();
      const start = listOpts.cursor ? filtered.indexOf(listOpts.cursor) + 1 : 0;
      const limit = listOpts.limit ?? 1000;
      const slice = filtered.slice(start, start + limit);
      const next = start + limit < filtered.length ? filtered[start + limit - 1]! : null;
      return { keys: slice, cursor: next };
    },

    async signUrl(key, signOpts) {
      if (!opts.urlSecret) {
        throw new Error('createLocalStorage: urlSecret required for signUrl()');
      }
      const expiresAt = Date.now() + (signOpts?.expiresIn ?? 3600) * 1000;
      const method = signOpts?.method ?? 'GET';
      const payload = `${method}:${sanitizeKey(key)}:${expiresAt}`;
      const signed = await sign(payload, opts.urlSecret);
      const base = opts.publicBaseUrl ?? `file://${root}`;
      return `${base}/${sanitizeKey(key)}?sig=${encodeURIComponent(signed)}`;
    },
  };
}

async function walkDir(fs: any, dir: string, out: string[], root: string): Promise<void> {
  let entries: any[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch { return; }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkDir(fs, full, out, root);
    } else {
      const rel = full.slice(root.length + 1);
      out.push(rel);
    }
  }
}

function sanitizeKey(key: string): string {
  // Reject empty, leading slashes, dot-traversal
  const cleaned = key.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!cleaned) return '';
  if (cleaned.includes('..')) {
    throw new Error(`Invalid storage key (path traversal): ${key}`);
  }
  return cleaned;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.slice(0, idx) : '.';
}

/* ═════════════ VERIFY SIGNED URL ═════════════ */

export async function verifyLocalSignedUrl(
  url: string,
  secret: string,
): Promise<{ valid: boolean; key?: string; method?: string }> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { valid: false }; }
  const sig = parsed.searchParams.get('sig');
  if (!sig) return { valid: false };

  const unsigned = await unsign(sig, secret);
  if (!unsigned) return { valid: false };

  const parts = unsigned.split(':');
  if (parts.length !== 3) return { valid: false };
  const [method, key, expStr] = parts;
  const exp = parseInt(expStr!, 10);
  if (!Number.isFinite(exp) || exp < Date.now()) return { valid: false };

  const pathKey = sanitizeKey(parsed.pathname.replace(/^\/[^/]*\//, '')); // strip /base/
  // Allow either the full path match OR direct key match (depends on base)
  if (pathKey !== key && !parsed.pathname.endsWith('/' + key)) {
    return { valid: false };
  }
  return { valid: true, key: key!, method: method! };
}

/* ═════════════ MEMORY DRIVER (TESTS) ═════════════ */

interface MemoryEntry {
  body: Uint8Array;
  contentType: string | null;
  metadata: Record<string, string>;
  modifiedAt: Date;
}

export function createMemoryStorage(urlSecret?: string): StorageAdapter {
  const entries = new Map<string, MemoryEntry>();

  return {
    driver: 'memory',

    async put(key, data, putOpts) {
      const cleanKey = sanitizeKey(key);
      let body: Uint8Array;
      if (data instanceof Uint8Array) {
        body = data;
      } else {
        const reader = (data as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        body = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { body.set(c, offset); offset += c.length; }
      }
      entries.set(cleanKey, {
        body,
        contentType: putOpts?.contentType ?? null,
        metadata: putOpts?.metadata ?? {},
        modifiedAt: new Date(),
      });
    },

    async get(key) {
      const entry = entries.get(sanitizeKey(key));
      if (!entry) throw new Error(`Not found: ${key}`);
      return {
        body: entry.body,
        contentType: entry.contentType,
        size: entry.body.length,
        metadata: entry.metadata,
      };
    },

    async delete(key) {
      entries.delete(sanitizeKey(key));
    },

    async exists(key) {
      return entries.has(sanitizeKey(key));
    },

    async stat(key) {
      const entry = entries.get(sanitizeKey(key));
      if (!entry) throw new Error(`Not found: ${key}`);
      return {
        size: entry.body.length,
        contentType: entry.contentType,
        modifiedAt: entry.modifiedAt,
        metadata: entry.metadata,
      };
    },

    async list(listOpts = {}) {
      const prefix = listOpts.prefix ?? '';
      const all = [...entries.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort();
      const start = listOpts.cursor ? all.indexOf(listOpts.cursor) + 1 : 0;
      const limit = listOpts.limit ?? 1000;
      const slice = all.slice(start, start + limit);
      const next = start + limit < all.length ? all[start + limit - 1]! : null;
      return { keys: slice, cursor: next };
    },

    async signUrl(key, signOpts) {
      if (!urlSecret) throw new Error('createMemoryStorage: urlSecret required for signUrl()');
      const expiresAt = Date.now() + (signOpts?.expiresIn ?? 3600) * 1000;
      const method = signOpts?.method ?? 'GET';
      const payload = `${method}:${sanitizeKey(key)}:${expiresAt}`;
      const signed = await sign(payload, urlSecret);
      return `memory://${sanitizeKey(key)}?sig=${encodeURIComponent(signed)}`;
    },
  };
}

/* ═════════════ S3/B2-COMPATIBLE DRIVER ═════════════ */

export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface S3StorageOptions {
  bucket: string;
  client: S3ClientLike;
  publicBaseUrl?: string;
  /** Function to produce SigV4 presigned URLs (provide from @aws-sdk/s3-request-presigner) */
  presign?: (key: string, expiresIn: number, method: 'GET' | 'PUT') => Promise<string>;
  /** Command factory to keep driver independent of aws-sdk version */
  commandFactory: {
    put(args: { Bucket: string; Key: string; Body: Uint8Array; ContentType?: string; Metadata?: Record<string, string>; CacheControl?: string }): unknown;
    get(args: { Bucket: string; Key: string }): unknown;
    delete(args: { Bucket: string; Key: string }): unknown;
    head(args: { Bucket: string; Key: string }): unknown;
    list(args: { Bucket: string; Prefix?: string; MaxKeys?: number; ContinuationToken?: string }): unknown;
  };
}

/**
 * S3-compatible storage (AWS S3, Backblaze B2, Cloudflare R2, MinIO, etc.).
 *
 * Vajra does NOT bundle aws-sdk. You bring your own SDK client + command factory
 * so the framework stays tiny and you stay on whichever SDK version fits your app.
 *
 * @example AWS S3 (aws-sdk v3)
 *   import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
 *            HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
 *   import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
 *
 *   const client = new S3Client({ region: 'ap-south-1' });
 *   const storage = createS3Storage({
 *     bucket: 'my-bucket',
 *     client,
 *     commandFactory: {
 *       put:    (a) => new PutObjectCommand(a),
 *       get:    (a) => new GetObjectCommand(a),
 *       delete: (a) => new DeleteObjectCommand(a),
 *       head:   (a) => new HeadObjectCommand(a),
 *       list:   (a) => new ListObjectsV2Command(a),
 *     },
 *     presign: async (key, expiresIn, method) => {
 *       const Cmd = method === 'PUT' ? PutObjectCommand : GetObjectCommand;
 *       return getSignedUrl(client, new Cmd({ Bucket: 'my-bucket', Key: key }), { expiresIn });
 *     },
 *   });
 *
 * @example Backblaze B2 (S3-compatible endpoint)
 *   const client = new S3Client({
 *     endpoint: 'https://s3.us-west-002.backblazeb2.com',
 *     region: 'us-west-002',
 *     credentials: { accessKeyId: B2_KEY, secretAccessKey: B2_SECRET },
 *   });
 *   // same createS3Storage call as above
 *
 * @example Cloudflare R2
 *   const client = new S3Client({
 *     endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
 *     region: 'auto',
 *     credentials: { accessKeyId: R2_KEY, secretAccessKey: R2_SECRET },
 *   });
 *   // same createS3Storage call
 */
export function createS3Storage(opts: S3StorageOptions): StorageAdapter {
  return {
    driver: 's3',

    async put(key, data, putOpts) {
      const body = data instanceof Uint8Array ? data : await streamToBuffer(data as ReadableStream<Uint8Array>);
      await opts.client.send(opts.commandFactory.put({
        Bucket: opts.bucket,
        Key: sanitizeKey(key),
        Body: body,
        ContentType: putOpts?.contentType,
        Metadata: putOpts?.metadata,
        CacheControl: putOpts?.cacheControl,
      }));
    },

    async get(key) {
      const res = await opts.client.send(opts.commandFactory.get({
        Bucket: opts.bucket,
        Key: sanitizeKey(key),
      })) as any;
      const body = res.Body ? new Uint8Array(await res.Body.transformToByteArray()) : new Uint8Array(0);
      return {
        body,
        contentType: res.ContentType ?? null,
        size: body.length,
        metadata: res.Metadata ?? {},
      };
    },

    async delete(key) {
      await opts.client.send(opts.commandFactory.delete({ Bucket: opts.bucket, Key: sanitizeKey(key) }));
    },

    async exists(key) {
      try {
        await opts.client.send(opts.commandFactory.head({ Bucket: opts.bucket, Key: sanitizeKey(key) }));
        return true;
      } catch { return false; }
    },

    async stat(key) {
      const res = await opts.client.send(opts.commandFactory.head({
        Bucket: opts.bucket,
        Key: sanitizeKey(key),
      })) as any;
      return {
        size: res.ContentLength ?? 0,
        contentType: res.ContentType ?? null,
        modifiedAt: res.LastModified ?? new Date(0),
        metadata: res.Metadata ?? {},
      };
    },

    async list(listOpts = {}) {
      const res = await opts.client.send(opts.commandFactory.list({
        Bucket: opts.bucket,
        Prefix: listOpts.prefix,
        MaxKeys: listOpts.limit ?? 1000,
        ContinuationToken: listOpts.cursor ?? undefined,
      })) as any;
      const keys = (res.Contents ?? []).map((c: any) => c.Key as string);
      const cursor = res.NextContinuationToken ?? null;
      return { keys, cursor };
    },

    async signUrl(key, signOpts) {
      if (!opts.presign) {
        if (opts.publicBaseUrl) {
          return `${opts.publicBaseUrl.replace(/\/+$/, '')}/${sanitizeKey(key)}`;
        }
        throw new Error('createS3Storage: presign function required for signUrl()');
      }
      return await opts.presign(sanitizeKey(key), signOpts?.expiresIn ?? 3600, signOpts?.method ?? 'GET');
    },
  };
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { buf.set(c, offset); offset += c.length; }
  return buf;
}
