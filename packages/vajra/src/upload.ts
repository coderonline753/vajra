/**
 * Vajra Upload Module
 * File upload with magic-byte validation, size limits, filename sanitization, optional disk spool.
 *
 * import { upload } from 'vajrajs';
 *
 * app.post('/avatar', async (ctx) => {
 *   const files = await upload(ctx, {
 *     fields: {
 *       avatar: { maxSize: '5mb', mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] },
 *     },
 *   });
 *   await files.avatar.save('/var/data/avatars/' + files.avatar.filename);
 *   return ctx.json({ ok: true });
 * });
 */

import type { Context } from './context';
import { HttpError, PayloadTooLargeError } from './errors';

class UploadError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = 'UploadError';
  }
}

/* ═════════════ TYPES ═════════════ */

export interface FieldOptions {
  /** Maximum size per file (e.g. "5mb", 5_000_000). Default: 10mb */
  maxSize?: string | number;
  /** Allowed MIME types (detected from magic bytes, not trusted from client). Empty = any. */
  mimeTypes?: string[];
  /** Allowed file extensions (case-insensitive). Empty = any. */
  extensions?: string[];
  /** Allow multiple files in this field. Default: false */
  multiple?: boolean;
  /** Required field. Default: false */
  required?: boolean;
}

export interface UploadOptions {
  /** Per-field configuration */
  fields: Record<string, FieldOptions>;
  /** Maximum total upload size across all fields. Default: 50mb */
  maxTotalSize?: string | number;
  /** Spool files larger than this to disk. Default: null (always memory) */
  diskSpoolThreshold?: string | number;
  /** Temporary directory for spooled files. Default: /tmp */
  tempDir?: string;
  /** Reject unknown fields (not in `fields` config). Default: true */
  rejectUnknownFields?: boolean;
  /** Optional virus/content scan hook. Return false to reject. */
  scan?: (file: UploadedFile) => Promise<boolean> | boolean;
}

export interface UploadedFile {
  /** Field name from the form */
  fieldName: string;
  /** Sanitized filename safe for filesystem use */
  filename: string;
  /** Original filename as sent by the browser (may contain unsafe chars) */
  originalFilename: string;
  /** MIME type detected from file magic bytes (authoritative) */
  mimeType: string;
  /** MIME type claimed by client in multipart Content-Type (not trusted) */
  claimedMimeType: string;
  /** File size in bytes */
  size: number;
  /** File content as buffer (null if spooled to disk) */
  buffer: Uint8Array | null;
  /** Filesystem path if spooled to disk (null if in memory) */
  tempPath: string | null;
  /** Save the file to a destination path. Creates parent dirs. */
  save(destPath: string): Promise<void>;
  /** Get file contents as ArrayBuffer */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Get file contents as text (UTF-8) */
  text(): Promise<string>;
  /** Get file contents as ReadableStream */
  stream(): ReadableStream<Uint8Array>;
}

export type UploadResult<F extends Record<string, FieldOptions>> = {
  [K in keyof F]: F[K]['multiple'] extends true ? UploadedFile[] : UploadedFile;
};

/* ═════════════ SIZE PARSING ═════════════ */

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

export function parseSize(input: string | number): number {
  if (typeof input === 'number') return Math.max(0, Math.floor(input));
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/i.exec(input);
  if (!match) throw new Error(`Invalid size string: ${input}`);
  const [, num, unit = 'b'] = match;
  const multiplier = SIZE_UNITS[unit.toLowerCase()];
  if (multiplier === undefined) throw new Error(`Unknown size unit: ${unit}`);
  return Math.floor(parseFloat(num) * multiplier);
}

/* ═════════════ FILENAME SANITIZATION ═════════════ */

const MAX_FILENAME_LENGTH = 200;
const UNSAFE_FILENAME_CHARS = /[\x00-\x1f\x7f<>:"/\\|?*]/g;

export function sanitizeFilename(original: string): string {
  if (!original || typeof original !== 'string') return randomFilename();
  // Strip path components (Windows + Unix)
  let name = original.replace(/^.*[\\/]/, '');
  // Remove control chars and unsafe filesystem chars
  name = name.replace(UNSAFE_FILENAME_CHARS, '_');
  // Collapse multiple dots (prevent double-extension tricks like .jpg.exe as .exe)
  name = name.replace(/\.{2,}/g, '.');
  // Trim leading/trailing dots and spaces
  name = name.replace(/^[.\s]+|[.\s]+$/g, '');
  // Truncate
  if (name.length > MAX_FILENAME_LENGTH) {
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0 && name.length - dotIdx <= 10) {
      const ext = name.slice(dotIdx);
      name = name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
    } else {
      name = name.slice(0, MAX_FILENAME_LENGTH);
    }
  }
  return name || randomFilename();
}

function randomFilename(): string {
  return `file_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.bin`;
}

export function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(idx + 1).toLowerCase() : '';
}

/* ═════════════ MAGIC BYTE DETECTION ═════════════ */

interface MagicSignature {
  bytes: readonly number[];
  offset: number;
  mime: string;
  ext: string;
  /** Additional validator for ambiguous signatures (e.g., WebP requires RIFF+WEBP check) */
  validate?: (buf: Uint8Array) => boolean;
}

const SIGNATURES: readonly MagicSignature[] = [
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0, mime: 'image/png', ext: 'png' },
  { bytes: [0xff, 0xd8, 0xff], offset: 0, mime: 'image/jpeg', ext: 'jpg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], offset: 0, mime: 'image/gif', ext: 'gif' },
  {
    bytes: [0x52, 0x49, 0x46, 0x46],
    offset: 0,
    mime: 'image/webp',
    ext: 'webp',
    validate: (buf) =>
      buf.length >= 12 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50, // "WEBP"
  },
  { bytes: [0x25, 0x50, 0x44, 0x46], offset: 0, mime: 'application/pdf', ext: 'pdf' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], offset: 0, mime: 'application/zip', ext: 'zip' },
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], offset: 0, mime: 'video/webm', ext: 'webm' },
  {
    bytes: [0x66, 0x74, 0x79, 0x70],
    offset: 4,
    mime: 'video/mp4',
    ext: 'mp4',
  },
  { bytes: [0x49, 0x44, 0x33], offset: 0, mime: 'audio/mpeg', ext: 'mp3' },
  { bytes: [0x4f, 0x67, 0x67, 0x53], offset: 0, mime: 'audio/ogg', ext: 'ogg' },
  { bytes: [0x42, 0x4d], offset: 0, mime: 'image/bmp', ext: 'bmp' },
  { bytes: [0x49, 0x49, 0x2a, 0x00], offset: 0, mime: 'image/tiff', ext: 'tiff' },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], offset: 0, mime: 'image/tiff', ext: 'tiff' },
];

export interface DetectedType {
  mime: string;
  ext: string;
}

export function detectFileType(buf: Uint8Array): DetectedType | null {
  for (const sig of SIGNATURES) {
    if (buf.length < sig.offset + sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buf[sig.offset + i] !== sig.bytes[i]) { match = false; break; }
    }
    if (!match) continue;
    if (sig.validate && !sig.validate(buf)) continue;
    return { mime: sig.mime, ext: sig.ext };
  }

  // Text-based formats need content sniff (first ~1KB)
  const head = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, Math.min(buf.length, 1024)));
  const trimmed = head.trimStart().toLowerCase();
  if (trimmed.startsWith('<?xml') && trimmed.includes('<svg')) return { mime: 'image/svg+xml', ext: 'svg' };
  if (trimmed.startsWith('<svg')) return { mime: 'image/svg+xml', ext: 'svg' };
  if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) return { mime: 'text/html', ext: 'html' };
  if (trimmed.startsWith('<?xml')) return { mime: 'application/xml', ext: 'xml' };

  // ASCII-printable text heuristic (simple but safe)
  if (isLikelyText(buf)) return { mime: 'text/plain', ext: 'txt' };

  return null;
}

function isLikelyText(buf: Uint8Array): boolean {
  const sample = buf.slice(0, Math.min(buf.length, 2048));
  if (sample.length === 0) return false;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0) return false; // binary has nulls
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) printable++;
    else if (byte >= 128) { /* possibly UTF-8 continuation, allow */ printable++; }
  }
  return printable / sample.length > 0.9;
}

/* ═════════════ MAIN UPLOAD FUNCTION ═════════════ */

export async function upload<F extends Record<string, FieldOptions>>(
  ctx: Context,
  options: { fields: F } & Omit<UploadOptions, 'fields'>,
): Promise<UploadResult<F>> {
  const ct = ctx.req.headers.get('content-type') || '';
  if (!ct.toLowerCase().includes('multipart/form-data')) {
    throw new HttpError(400, 'Expected multipart/form-data request');
  }

  const maxTotal = parseSize(options.maxTotalSize ?? '50mb');
  const declaredLength = parseInt(ctx.req.headers.get('content-length') || '0', 10);
  if (declaredLength > maxTotal) {
    throw new PayloadTooLargeError(maxTotal);
  }

  const spoolThreshold = options.diskSpoolThreshold != null ? parseSize(options.diskSpoolThreshold) : null;
  const tempDir = options.tempDir ?? '/tmp';
  const rejectUnknown = options.rejectUnknownFields ?? true;
  const configuredFields = new Set(Object.keys(options.fields));

  let formData: FormData;
  try {
    formData = await ctx.req.formData();
  } catch {
    throw new HttpError(400, 'Invalid multipart form data');
  }

  const collected: Record<string, UploadedFile[]> = Object.create(null);
  let totalSize = 0;

  for (const [fieldName, value] of formData.entries()) {
    if (!(value instanceof File) && typeof value !== 'object') continue;
    if (!(value instanceof File)) continue;

    if (rejectUnknown && !configuredFields.has(fieldName)) {
      throw new UploadError(`Unknown upload field: ${fieldName}`);
    }
    const fieldConfig = options.fields[fieldName];
    if (!fieldConfig) continue; // skip if rejectUnknown=false

    const maxSize = parseSize(fieldConfig.maxSize ?? '10mb');
    if (value.size > maxSize) {
      throw new PayloadTooLargeError(maxSize);
    }
    totalSize += value.size;
    if (totalSize > maxTotal) {
      throw new PayloadTooLargeError(maxTotal);
    }

    const buffer = new Uint8Array(await value.arrayBuffer());
    const sanitized = sanitizeFilename(value.name);

    const detected = detectFileType(buffer);
    const detectedMime = detected?.mime ?? 'application/octet-stream';
    const detectedExt = detected?.ext ?? getExtension(sanitized);

    if (fieldConfig.mimeTypes?.length && !fieldConfig.mimeTypes.includes(detectedMime)) {
      throw new UploadError(
        `File type "${detectedMime}" not allowed for field "${fieldName}". Allowed: ${fieldConfig.mimeTypes.join(', ')}`,
      );
    }
    if (fieldConfig.extensions?.length) {
      const allowedLower = fieldConfig.extensions.map((e) => e.toLowerCase().replace(/^\./, ''));
      const claimedExt = getExtension(sanitized);
      // When magic-byte detection succeeded, the detected extension is authoritative.
      // Claimed extension (from filename) is only a fallback for formats we cannot detect.
      // This blocks rename attacks: malware.exe renamed to malware.jpg must still be
      // rejected because detectedExt=exe does not match the allow list.
      if (detected) {
        if (!allowedLower.includes(detectedExt)) {
          throw new UploadError(
            `Extension ".${detectedExt}" (from content) not allowed for field "${fieldName}". Allowed: ${allowedLower.map((e) => '.' + e).join(', ')}`,
          );
        }
      } else {
        if (!allowedLower.includes(claimedExt)) {
          throw new UploadError(
            `Extension ".${claimedExt}" not allowed for field "${fieldName}". Allowed: ${allowedLower.map((e) => '.' + e).join(', ')}`,
          );
        }
      }
    }

    let bufRef: Uint8Array | null = buffer;
    let tempPath: string | null = null;
    if (spoolThreshold != null && value.size > spoolThreshold) {
      tempPath = await spoolToDisk(tempDir, buffer);
      bufRef = null;
    }

    const file: UploadedFile = makeUploadedFile({
      fieldName,
      filename: sanitized,
      originalFilename: value.name,
      mimeType: detectedMime,
      claimedMimeType: value.type || 'application/octet-stream',
      size: value.size,
      buffer: bufRef,
      tempPath,
    });

    if (options.scan) {
      const ok = await options.scan(file);
      if (!ok) {
        if (tempPath) await safeUnlink(tempPath);
        throw new UploadError(`File rejected by scan: ${fieldName}/${sanitized}`);
      }
    }

    if (!collected[fieldName]) collected[fieldName] = [];
    if (!fieldConfig.multiple && collected[fieldName].length >= 1) {
      throw new UploadError(`Field "${fieldName}" accepts only one file`);
    }
    collected[fieldName].push(file);
  }

  const result: Record<string, UploadedFile | UploadedFile[]> = Object.create(null);
  for (const [name, config] of Object.entries(options.fields)) {
    const files = collected[name] ?? [];
    if (config.required && files.length === 0) {
      throw new UploadError(`Required upload field missing: ${name}`);
    }
    if (config.multiple) result[name] = files;
    else result[name] = files[0]!; // may be undefined if not required; caller decides
  }

  return result as UploadResult<F>;
}

/* ═════════════ FILE HELPERS ═════════════ */

interface FileInit {
  fieldName: string;
  filename: string;
  originalFilename: string;
  mimeType: string;
  claimedMimeType: string;
  size: number;
  buffer: Uint8Array | null;
  tempPath: string | null;
}

function makeUploadedFile(init: FileInit): UploadedFile {
  return {
    ...init,
    async save(destPath: string): Promise<void> {
      await ensureParentDir(destPath);
      if (init.buffer) {
        await Bun.write(destPath, init.buffer);
      } else if (init.tempPath) {
        const source = Bun.file(init.tempPath);
        await Bun.write(destPath, source);
      } else {
        throw new Error('UploadedFile has no buffer or tempPath');
      }
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      if (init.buffer) {
        return init.buffer.buffer.slice(init.buffer.byteOffset, init.buffer.byteOffset + init.buffer.byteLength) as ArrayBuffer;
      }
      if (init.tempPath) {
        return await Bun.file(init.tempPath).arrayBuffer();
      }
      throw new Error('UploadedFile has no data');
    },
    async text(): Promise<string> {
      if (init.buffer) return new TextDecoder('utf-8').decode(init.buffer);
      if (init.tempPath) return await Bun.file(init.tempPath).text();
      throw new Error('UploadedFile has no data');
    },
    stream(): ReadableStream<Uint8Array> {
      if (init.buffer) {
        const buf = init.buffer;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(buf);
            controller.close();
          },
        });
      }
      if (init.tempPath) return Bun.file(init.tempPath).stream();
      throw new Error('UploadedFile has no data');
    },
  };
}

async function spoolToDisk(tempDir: string, buffer: Uint8Array): Promise<string> {
  const name = `vajra_upload_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  const path = `${tempDir.replace(/\/+$/, '')}/${name}`;
  await Bun.write(path, buffer);
  return path;
}

async function ensureParentDir(destPath: string): Promise<void> {
  const idx = destPath.lastIndexOf('/');
  if (idx <= 0) return;
  const dir = destPath.slice(0, idx);
  // Bun.write creates parents automatically for file paths, but for explicit dirs:
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
  } catch { /* ignore if exists or Node fs unavailable */ }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(path);
  } catch { /* ignore */ }
}
