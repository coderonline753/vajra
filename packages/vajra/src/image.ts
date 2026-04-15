/**
 * Vajra Image Processing Module
 * URL-based transforms, filesystem cache, magic byte validation.
 * Uses Sharp internally but exposes a clean middleware API.
 *
 * @example
 *   app.use(imageProcessor({ source: './uploads', cache: './cache/images' }));
 *   // GET /images/photo.jpg?w=300&h=200&format=webp&q=80
 */

import type { Context } from './context';
import type { Middleware } from './middleware';
import { createHash } from 'crypto';

/* ═══════ TYPES ═══════ */

interface ImageProcessorOptions {
  /** Source directory for original images */
  source: string;
  /** Cache directory for processed images */
  cache: string;
  /** URL prefix to match. Default: /images */
  prefix?: string;
  /** Max output width. Default: 4096 */
  maxWidth?: number;
  /** Max output height. Default: 4096 */
  maxHeight?: number;
  /** Max input file size in bytes. Default: 25MB */
  maxFileSize?: number;
  /** Allowed output formats. Default: ['jpeg', 'png', 'webp', 'avif'] */
  allowedFormats?: string[];
  /** Default output quality. Default: 80 */
  defaultQuality?: number;
  /** Cache TTL for Cache-Control header in seconds. Default: 86400 (1 day) */
  cacheTTL?: number;
  /** Max concurrent processing operations. Default: 10 */
  maxConcurrent?: number;
  /** Strip EXIF data. Default: true */
  stripExif?: boolean;
}

interface TransformParams {
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  format?: string;
  quality?: number;
  blur?: number;
  rotate?: number;
  flip?: boolean;
  flop?: boolean;
  grayscale?: boolean;
}

/* ═══════ MAGIC BYTES VALIDATION ═══════ */

const MAGIC_BYTES: Record<string, number[]> = {
  jpeg: [0xFF, 0xD8, 0xFF],
  png: [0x89, 0x50, 0x4E, 0x47],
  gif: [0x47, 0x49, 0x46],
  webp: [0x52, 0x49, 0x46, 0x46],
  bmp: [0x42, 0x4D],
};

function detectFormat(header: Uint8Array): string | null {
  for (const [format, bytes] of Object.entries(MAGIC_BYTES)) {
    if (bytes.every((b, i) => header[i] === b)) {
      // WebP needs extra check at offset 8
      if (format === 'webp') {
        const webpSig = [0x57, 0x45, 0x42, 0x50]; // WEBP
        if (webpSig.every((b, i) => header[8 + i] === b)) return 'webp';
        return null;
      }
      return format;
    }
  }
  // AVIF: check for ftyp box
  if (header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70) {
    return 'avif';
  }
  return null;
}

/* ═══════ CONCURRENCY LIMITER ═══════ */

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/* ═══════ HELPERS ═══════ */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseTransformParams(query: Record<string, string>, opts: ImageProcessorOptions): TransformParams {
  const params: TransformParams = {};

  if (query.w) params.width = clamp(parseInt(query.w) || 0, 1, opts.maxWidth || 4096);
  if (query.h) params.height = clamp(parseInt(query.h) || 0, 1, opts.maxHeight || 4096);
  if (query.fit && ['cover', 'contain', 'fill', 'inside', 'outside'].includes(query.fit)) {
    params.fit = query.fit as TransformParams['fit'];
  }
  if (query.format && (opts.allowedFormats || ['jpeg', 'png', 'webp', 'avif']).includes(query.format)) {
    params.format = query.format;
  }
  if (query.q) params.quality = clamp(parseInt(query.q) || opts.defaultQuality || 80, 1, 100);
  if (query.blur) params.blur = clamp(parseFloat(query.blur) || 0, 0.3, 100);
  if (query.rotate) params.rotate = parseInt(query.rotate) || 0;
  if (query.flip === 'true') params.flip = true;
  if (query.flop === 'true') params.flop = true;
  if (query.grayscale === 'true') params.grayscale = true;

  return params;
}

function generateCacheKey(filename: string, params: TransformParams): string {
  const hash = createHash('sha256')
    .update(`${filename}:${JSON.stringify(params)}`)
    .digest('hex');
  return hash;
}

const MIME_TYPES: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
};

/* ═══════ PROCESSOR ═══════ */

async function processImage(
  inputPath: string,
  params: TransformParams,
  opts: ImageProcessorOptions
): Promise<{ buffer: Buffer; format: string }> {
  // Dynamic import Sharp (optional dependency)
  let sharp: any;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    throw new Error('Sharp is required for image processing. Install it: bun add sharp');
  }

  let pipeline = sharp(inputPath);

  // Auto-rotate based on EXIF orientation + optionally strip EXIF
  if (opts.stripExif !== false) {
    pipeline = pipeline.rotate(); // Auto-orient + strip
  }

  // Resize
  if (params.width || params.height) {
    pipeline = pipeline.resize({
      width: params.width,
      height: params.height,
      fit: params.fit || 'cover',
      withoutEnlargement: true,
    });
  }

  // Transforms
  if (params.rotate) pipeline = pipeline.rotate(params.rotate);
  if (params.blur) pipeline = pipeline.blur(params.blur);
  if (params.grayscale) pipeline = pipeline.grayscale();
  if (params.flip) pipeline = pipeline.flip();
  if (params.flop) pipeline = pipeline.flop();

  // Output format
  const format = params.format || 'webp';
  const quality = params.quality || opts.defaultQuality || 80;

  switch (format) {
    case 'jpeg':
    case 'jpg':
      pipeline = pipeline.jpeg({ quality, mozjpeg: true });
      break;
    case 'png':
      pipeline = pipeline.png({ quality, compressionLevel: 9 });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality });
      break;
    case 'avif':
      pipeline = pipeline.avif({ quality });
      break;
    default:
      pipeline = pipeline.webp({ quality });
  }

  const buffer = await pipeline.toBuffer();
  return { buffer, format };
}

/* ═══════ MIDDLEWARE ═══════ */

/**
 * Image processing middleware.
 * Intercepts requests matching the prefix, applies transforms, caches result.
 *
 * URL params: ?w=300&h=200&fit=cover&format=webp&q=80&blur=5&rotate=90&grayscale=true&flip=true
 */
export function imageProcessor(options: ImageProcessorOptions): Middleware {
  const prefix = options.prefix || '/images';
  const cacheTTL = options.cacheTTL ?? 86400;
  const semaphore = new Semaphore(options.maxConcurrent || 10);
  const maxFileSize = options.maxFileSize || 25 * 1024 * 1024;

  // Ensure directories exist
  (async () => {
    const { mkdir } = await import('fs/promises');
    await mkdir(options.source, { recursive: true }).catch(() => {});
    await mkdir(options.cache, { recursive: true }).catch(() => {});
  })();

  return async (c, next) => {
    if (!c.path.startsWith(prefix + '/')) return next();

    const filename = c.path.slice(prefix.length + 1);

    // Security: path traversal prevention
    if (filename.includes('..') || filename.includes('\0') || filename.startsWith('/')) {
      return c.json({ error: 'Invalid path', code: 'INVALID_PATH' }, 400);
    }

    const sourcePath = `${options.source}/${filename}`;
    const sourceFile = Bun.file(sourcePath);

    // Check source exists
    if (!await sourceFile.exists()) {
      return c.json({ error: 'Image not found', code: 'NOT_FOUND' }, 404);
    }

    // Check file size
    if (sourceFile.size > maxFileSize) {
      return c.json({ error: 'Image too large', code: 'FILE_TOO_LARGE' }, 413);
    }

    // Validate magic bytes
    const header = new Uint8Array(await sourceFile.slice(0, 12).arrayBuffer());
    const detectedFormat = detectFormat(header);
    if (!detectedFormat) {
      return c.json({ error: 'Invalid image format', code: 'INVALID_FORMAT' }, 415);
    }

    // Parse transform params
    const params = parseTransformParams(c.queries, options);

    // No transforms? Serve original
    if (!params.width && !params.height && !params.format && !params.blur && !params.rotate && !params.grayscale && !params.flip && !params.flop) {
      const mime = MIME_TYPES[detectedFormat] || 'application/octet-stream';
      c.setHeader('content-type', mime);
      c.setHeader('cache-control', `public, max-age=${cacheTTL}`);
      return new Response(sourceFile.stream(), { status: 200, headers: c['_headers'] });
    }

    // Check cache
    const cacheKey = generateCacheKey(filename, params);
    const outputFormat = params.format || 'webp';
    const cachePath = `${options.cache}/${cacheKey}.${outputFormat}`;
    const cacheFile = Bun.file(cachePath);

    if (await cacheFile.exists()) {
      c.setHeader('content-type', MIME_TYPES[outputFormat] || 'image/webp');
      c.setHeader('cache-control', `public, max-age=${cacheTTL}`);
      c.setHeader('x-vajra-cache', 'HIT');
      return new Response(cacheFile.stream(), { status: 200, headers: c['_headers'] });
    }

    // Process image (with concurrency limit)
    await semaphore.acquire();
    try {
      const { buffer, format } = await processImage(sourcePath, params, options);

      // Write to cache
      await Bun.write(cachePath, buffer);

      c.setHeader('content-type', MIME_TYPES[format] || 'image/webp');
      c.setHeader('cache-control', `public, max-age=${cacheTTL}`);
      c.setHeader('x-vajra-cache', 'MISS');
      return new Response(buffer, { status: 200, headers: c['_headers'] });
    } catch (err: any) {
      return c.json({ error: 'Image processing failed', message: err.message, code: 'PROCESSING_ERROR' }, 500);
    } finally {
      semaphore.release();
    }
  };
}

/**
 * Generate srcset for responsive images.
 *
 * @example
 *   const srcset = generateSrcset('/images/hero.jpg', [320, 640, 1024, 1920]);
 *   // "/images/hero.jpg?w=320&format=webp 320w, /images/hero.jpg?w=640&format=webp 640w, ..."
 */
export function generateSrcset(imagePath: string, widths: number[], format = 'webp'): string {
  return widths.map(w => `${imagePath}?w=${w}&format=${format} ${w}w`).join(', ');
}

/**
 * Get image metadata without processing.
 */
export async function getImageMetadata(filePath: string): Promise<{
  width: number;
  height: number;
  format: string;
  size: number;
  hasAlpha: boolean;
} | null> {
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(filePath).metadata();
    return {
      width: meta.width || 0,
      height: meta.height || 0,
      format: meta.format || 'unknown',
      size: meta.size || 0,
      hasAlpha: meta.hasAlpha || false,
    };
  } catch {
    return null;
  }
}

export { detectFormat, generateCacheKey };
export type { ImageProcessorOptions, TransformParams };
