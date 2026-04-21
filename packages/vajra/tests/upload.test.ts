import { describe, test, expect } from 'bun:test';
import {
  upload,
  parseSize,
  sanitizeFilename,
  getExtension,
  detectFileType,
} from '../src/upload';
import { Context } from '../src/context';

/* ═══════════ SIZE PARSING ═══════════ */

describe('parseSize', () => {
  test('parses plain numbers', () => {
    expect(parseSize(1024)).toBe(1024);
    expect(parseSize(0)).toBe(0);
  });

  test('parses byte strings', () => {
    expect(parseSize('1024')).toBe(1024);
    expect(parseSize('1024b')).toBe(1024);
    expect(parseSize('1024 b')).toBe(1024);
  });

  test('parses kb/mb/gb', () => {
    expect(parseSize('1kb')).toBe(1024);
    expect(parseSize('5mb')).toBe(5 * 1024 * 1024);
    expect(parseSize('2gb')).toBe(2 * 1024 * 1024 * 1024);
  });

  test('parses decimal sizes', () => {
    expect(parseSize('1.5mb')).toBe(1.5 * 1024 * 1024);
    expect(parseSize('0.5kb')).toBe(512);
  });

  test('case insensitive', () => {
    expect(parseSize('5MB')).toBe(5 * 1024 * 1024);
    expect(parseSize('5Mb')).toBe(5 * 1024 * 1024);
  });

  test('rejects invalid input', () => {
    expect(() => parseSize('abc')).toThrow();
    expect(() => parseSize('5xb')).toThrow();
  });

  test('floors negative to zero', () => {
    expect(parseSize(-100)).toBe(0);
  });
});

/* ═══════════ FILENAME SANITIZATION ═══════════ */

describe('sanitizeFilename', () => {
  test('strips path traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\windows\\system.ini')).toBe('system.ini');
  });

  test('removes null bytes and control chars', () => {
    expect(sanitizeFilename('file\x00name.txt')).toBe('file_name.txt');
    expect(sanitizeFilename('file\x01\x02.txt')).toBe('file__.txt');
  });

  test('removes unsafe filesystem characters', () => {
    expect(sanitizeFilename('name<>:"|?*.txt')).toBe('name_______.txt');
  });

  test('collapses consecutive dots', () => {
    expect(sanitizeFilename('file...name.txt')).toBe('file.name.txt');
  });

  test('prevents double extension tricks', () => {
    // ".jpg.exe" stays intact (not rewritten to ".exe") but dots normalized
    const sanitized = sanitizeFilename('innocent.jpg.exe');
    expect(sanitized).toBe('innocent.jpg.exe');
  });

  test('trims leading/trailing dots and spaces', () => {
    expect(sanitizeFilename('  file.txt  ')).toBe('file.txt');
    expect(sanitizeFilename('.hidden')).toBe('hidden');
  });

  test('truncates long names preserving extension', () => {
    const long = 'a'.repeat(250) + '.jpg';
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('.jpg')).toBe(true);
  });

  test('returns random filename for empty/invalid input', () => {
    expect(sanitizeFilename('')).toMatch(/^file_\d+_[a-z0-9]+\.bin$/);
    expect(sanitizeFilename('....')).toMatch(/^file_\d+_[a-z0-9]+\.bin$/);
  });
});

describe('getExtension', () => {
  test('returns lowercase extension', () => {
    expect(getExtension('photo.JPG')).toBe('jpg');
    expect(getExtension('archive.tar.gz')).toBe('gz');
  });

  test('empty for files without extension', () => {
    expect(getExtension('README')).toBe('');
    expect(getExtension('.hidden')).toBe('');
  });
});

/* ═══════════ MAGIC BYTE DETECTION ═══════════ */

describe('detectFileType', () => {
  test('detects PNG', () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(detectFileType(buf)?.mime).toBe('image/png');
    expect(detectFileType(buf)?.ext).toBe('png');
  });

  test('detects JPEG', () => {
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    expect(detectFileType(buf)?.mime).toBe('image/jpeg');
  });

  test('detects GIF', () => {
    const buf = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectFileType(buf)?.mime).toBe('image/gif');
  });

  test('detects WebP (requires full RIFF...WEBP signature)', () => {
    const buf = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // size placeholder
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    expect(detectFileType(buf)?.mime).toBe('image/webp');
  });

  test('rejects RIFF without WEBP marker', () => {
    const buf = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00,
      0x41, 0x56, 0x49, 0x20, // AVI (not WEBP)
    ]);
    expect(detectFileType(buf)?.mime).not.toBe('image/webp');
  });

  test('detects PDF', () => {
    const buf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    expect(detectFileType(buf)?.mime).toBe('application/pdf');
  });

  test('detects MP4 by ftyp at offset 4', () => {
    const buf = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
    expect(detectFileType(buf)?.mime).toBe('video/mp4');
  });

  test('detects WebM', () => {
    const buf = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
    expect(detectFileType(buf)?.mime).toBe('video/webm');
  });

  test('detects SVG', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(detectFileType(svg)?.mime).toBe('image/svg+xml');
  });

  test('detects XML-wrapped SVG', () => {
    const svg = new TextEncoder().encode('<?xml version="1.0"?><svg></svg>');
    expect(detectFileType(svg)?.mime).toBe('image/svg+xml');
  });

  test('returns null for unknown binary', () => {
    const buf = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x00]);
    expect(detectFileType(buf)).toBeNull();
  });

  test('returns text/plain for printable ASCII', () => {
    const text = new TextEncoder().encode('Hello, this is a plain text file.\nWith multiple lines.\n');
    expect(detectFileType(text)?.mime).toBe('text/plain');
  });

  test('returns null for empty buffer', () => {
    expect(detectFileType(new Uint8Array(0))).toBeNull();
  });
});

/* ═══════════ UPLOAD FLOW ═══════════ */

function makeMultipartRequest(parts: Array<{ name: string; filename?: string; type?: string; content: Uint8Array | string }>): Request {
  const boundary = '----vajratestboundary' + Math.random().toString(36).slice(2, 10);
  const chunks: (string | Uint8Array)[] = [];
  for (const part of parts) {
    chunks.push(`--${boundary}\r\n`);
    if (part.filename) {
      chunks.push(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`);
      chunks.push(`Content-Type: ${part.type ?? 'application/octet-stream'}\r\n\r\n`);
    } else {
      chunks.push(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`);
    }
    chunks.push(part.content);
    chunks.push('\r\n');
  }
  chunks.push(`--${boundary}--\r\n`);

  const encoder = new TextEncoder();
  const buffers = chunks.map((c) => typeof c === 'string' ? encoder.encode(c) : c);
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) { body.set(b, offset); offset += b.length; }

  return new Request('http://localhost/upload', {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
    body,
  });
}

describe('upload()', () => {
  test('accepts a valid PNG', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    const req = makeMultipartRequest([
      { name: 'avatar', filename: 'me.png', type: 'image/png', content: png },
    ]);
    const ctx = new Context(req);

    const files = await upload(ctx, {
      fields: { avatar: { maxSize: '5mb', mimeTypes: ['image/png'] } },
    });

    expect(files.avatar.size).toBe(png.length);
    expect(files.avatar.mimeType).toBe('image/png');
    expect(files.avatar.filename).toBe('me.png');
  });

  test('rejects MIME mismatch (claimed png, actual text)', async () => {
    const fake = new TextEncoder().encode('I am text pretending to be PNG');
    const req = makeMultipartRequest([
      { name: 'avatar', filename: 'fake.png', type: 'image/png', content: fake },
    ]);
    const ctx = new Context(req);

    expect(
      upload(ctx, {
        fields: { avatar: { maxSize: '5mb', mimeTypes: ['image/png'] } },
      }),
    ).rejects.toThrow(/not allowed/);
  });

  test('rejects file over maxSize', async () => {
    const big = new Uint8Array(2048);
    big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
    big[4] = 0x0d; big[5] = 0x0a; big[6] = 0x1a; big[7] = 0x0a;
    const req = makeMultipartRequest([
      { name: 'avatar', filename: 'big.png', type: 'image/png', content: big },
    ]);
    const ctx = new Context(req);

    expect(
      upload(ctx, {
        fields: { avatar: { maxSize: 1024, mimeTypes: ['image/png'] } },
      }),
    ).rejects.toThrow();
  });

  test('sanitizes malicious filename', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const req = makeMultipartRequest([
      { name: 'avatar', filename: '../../../etc/passwd.png', type: 'image/png', content: png },
    ]);
    const ctx = new Context(req);

    const files = await upload(ctx, {
      fields: { avatar: { maxSize: '5mb', mimeTypes: ['image/png'] } },
    });
    expect(files.avatar.filename).toBe('passwd.png');
    expect(files.avatar.filename).not.toContain('/');
    expect(files.avatar.filename).not.toContain('..');
  });

  test('rejects unknown fields by default', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const req = makeMultipartRequest([
      { name: 'mystery', filename: 'x.png', type: 'image/png', content: png },
    ]);
    const ctx = new Context(req);

    expect(
      upload(ctx, {
        fields: { avatar: { maxSize: '5mb' } },
      }),
    ).rejects.toThrow(/Unknown upload field/);
  });

  test('allows unknown fields when rejectUnknownFields=false', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const req = makeMultipartRequest([
      { name: 'mystery', filename: 'x.png', type: 'image/png', content: png },
      { name: 'avatar', filename: 'y.png', type: 'image/png', content: png },
    ]);
    const ctx = new Context(req);

    const files = await upload(ctx, {
      fields: { avatar: { maxSize: '5mb', mimeTypes: ['image/png'] } },
      rejectUnknownFields: false,
    });
    expect(files.avatar).toBeDefined();
  });

  test('supports multiple files in one field', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const req = makeMultipartRequest([
      { name: 'photos', filename: 'a.png', type: 'image/png', content: png },
      { name: 'photos', filename: 'b.png', type: 'image/png', content: png },
    ]);
    const ctx = new Context(req);

    const files = await upload(ctx, {
      fields: { photos: { maxSize: '5mb', multiple: true, mimeTypes: ['image/png'] } },
    });
    expect(Array.isArray(files.photos)).toBe(true);
    expect((files.photos as any).length).toBe(2);
  });

  test('rejects multiple files when multiple=false', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const req = makeMultipartRequest([
      { name: 'avatar', filename: 'a.png', type: 'image/png', content: png },
      { name: 'avatar', filename: 'b.png', type: 'image/png', content: png },
    ]);
    const ctx = new Context(req);

    expect(
      upload(ctx, {
        fields: { avatar: { maxSize: '5mb', mimeTypes: ['image/png'] } },
      }),
    ).rejects.toThrow(/only one file/);
  });

  test('rejects when required field missing', async () => {
    const req = makeMultipartRequest([
      { name: 'other', content: 'ignored' },
    ]);
    const ctx = new Context(req);

    expect(
      upload(ctx, {
        fields: { avatar: { maxSize: '5mb', required: true } },
        rejectUnknownFields: false,
      }),
    ).rejects.toThrow(/Required upload field missing/);
  });

  test('scan hook can reject files', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const req = makeMultipartRequest([
      { name: 'avatar', filename: 'virus.png', type: 'image/png', content: png },
    ]);
    const ctx = new Context(req);

    expect(
      upload(ctx, {
        fields: { avatar: { maxSize: '5mb', mimeTypes: ['image/png'] } },
        scan: async () => false,
      }),
    ).rejects.toThrow(/rejected by scan/);
  });

  test('uploaded file exposes buffer and text accessors', async () => {
    const text = new TextEncoder().encode('Hello, world!');
    const req = makeMultipartRequest([
      { name: 'doc', filename: 'hello.txt', type: 'text/plain', content: text },
    ]);
    const ctx = new Context(req);

    const files = await upload(ctx, {
      fields: { doc: { maxSize: '1mb' } },
    });

    const ab = await files.doc.arrayBuffer();
    expect(new Uint8Array(ab)).toEqual(text);
    expect(await files.doc.text()).toBe('Hello, world!');
  });

  test('rejects non-multipart requests', async () => {
    const req = new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });
    const ctx = new Context(req);

    expect(
      upload(ctx, { fields: { avatar: {} } }),
    ).rejects.toThrow(/multipart/);
  });

  test('rejects when total size exceeds maxTotalSize', async () => {
    const big = new Uint8Array(600 * 1024);
    big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
    big[4] = 0x0d; big[5] = 0x0a; big[6] = 0x1a; big[7] = 0x0a;
    const req = makeMultipartRequest([
      { name: 'photos', filename: 'a.png', type: 'image/png', content: big },
      { name: 'photos', filename: 'b.png', type: 'image/png', content: big },
    ]);
    const ctx = new Context(req);

    expect(
      upload(ctx, {
        fields: { photos: { maxSize: '1mb', multiple: true, mimeTypes: ['image/png'] } },
        maxTotalSize: '1mb',
      }),
    ).rejects.toThrow();
  });

  test('extension whitelist works independently of mime', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const req = makeMultipartRequest([
      { name: 'photo', filename: 'pic.gif', type: 'image/gif', content: png },
    ]);
    const ctx = new Context(req);

    expect(
      upload(ctx, {
        fields: { photo: { maxSize: '5mb', extensions: ['jpg', 'jpeg'] } },
      }),
    ).rejects.toThrow(/Extension/);
  });

  test('rejects rename-to-allowed-extension attack (detected ext is authoritative)', async () => {
    // A PDF renamed to .jpg must still be rejected because detectFileType()
    // returns pdf from the magic bytes; the claimed .jpg is not consulted
    // when detection succeeds.
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
    const req = makeMultipartRequest([
      { name: 'photo', filename: 'innocent.jpg', type: 'image/jpeg', content: pdfBytes },
    ]);
    const ctx = new Context(req);

    await expect(
      upload(ctx, {
        fields: { photo: { maxSize: '5mb', extensions: ['jpg', 'jpeg', 'png'] } },
      }),
    ).rejects.toThrow(/Extension ".*pdf".*from content/);
  });

  test('falls back to claimed extension when detection returns null', async () => {
    // Plain CSV text has no magic bytes; detectFileType returns null,
    // so the claimed extension from the filename is used.
    const csvBytes = new TextEncoder().encode('name,email\nAlice,a@x.x\n');
    const req = makeMultipartRequest([
      { name: 'doc', filename: 'data.csv', type: 'text/csv', content: csvBytes },
    ]);
    const ctx = new Context(req);

    const files = await upload(ctx, {
      fields: { doc: { maxSize: '1mb', extensions: ['csv', 'txt'] } },
    });
    expect(files.doc).toBeDefined();
    expect((files.doc as any).filename).toBe('data.csv');
  });
});
