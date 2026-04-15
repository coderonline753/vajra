/**
 * Vajra Static File Serving
 * Zero-copy file serving with Bun.file(), MIME detection, ETag support.
 */

import type { Middleware } from './middleware';
import { createHash } from 'crypto';

interface StaticOptions {
  root: string;
  index?: string;
  maxAge?: number;
  etag?: boolean;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf('.'));
  return MIME_TYPES[ext] || 'application/octet-stream';
}

export function serveStatic(options: StaticOptions): Middleware {
  const root = options.root.replace(/\/$/, '');
  const index = options.index ?? 'index.html';
  const maxAge = options.maxAge ?? 86400;
  const useEtag = options.etag ?? true;

  return async (c, next) => {
    if (c.method !== 'GET' && c.method !== 'HEAD') {
      return next();
    }

    let filePath = c.path;

    // Prevent directory traversal
    if (filePath.includes('..') || filePath.includes('\0')) {
      return next();
    }

    // Resolve full path
    const fullPath = `${root}${filePath}`;
    const file = Bun.file(fullPath);

    let targetFile = file;
    let targetPath = fullPath;

    // Check if it's a directory, try index file
    if (!(await targetFile.exists())) {
      const indexPath = `${fullPath.replace(/\/$/, '')}/${index}`;
      const indexFile = Bun.file(indexPath);
      if (await indexFile.exists()) {
        targetFile = indexFile;
        targetPath = indexPath;
      } else {
        return next();
      }
    }

    const headers = new Headers();
    headers.set('content-type', getMimeType(targetPath));
    headers.set('cache-control', `public, max-age=${maxAge}`);

    if (useEtag) {
      const stat = targetFile.size;
      const lastModified = targetFile.lastModified;
      const etag = `"${createHash('md5').update(`${stat}-${lastModified}`).digest('hex').slice(0, 16)}"`;
      headers.set('etag', etag);

      const ifNoneMatch = c.header('if-none-match');
      if (ifNoneMatch === etag) {
        return new Response(null, { status: 304, headers });
      }
    }

    if (c.method === 'HEAD') {
      headers.set('content-length', String(targetFile.size));
      return new Response(null, { status: 200, headers });
    }

    return new Response(targetFile, { status: 200, headers });
  };
}
