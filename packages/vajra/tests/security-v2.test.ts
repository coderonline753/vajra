import { describe, test, expect } from 'bun:test';
import { Vajra } from '../src/vajra';
import { contentType, isInternalUrl, isPrivateIP, ssrfGuard, requestId } from '../src/security';

describe('Content-Type Validation', () => {
  test('allows matching content type', async () => {
    const app = new Vajra();
    app.post('/api/users', contentType('json'), async (c) => {
      return c.json({ ok: true });
    });

    const res = await app.handle(new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    }));
    expect(res.status).toBe(200);
  });

  test('rejects wrong content type', async () => {
    const app = new Vajra();
    app.post('/api/users', contentType('json'), async (c) => {
      return c.json({ ok: true });
    });

    const res = await app.handle(new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: '<user><name>test</name></user>',
    }));
    expect(res.status).toBe(415);
  });

  test('allows multiple types', async () => {
    const app = new Vajra();
    app.post('/upload', contentType(['json', 'multipart']), async (c) => {
      return c.json({ ok: true });
    });

    const res = await app.handle(new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }));
    expect(res.status).toBe(200);
  });

  test('skips GET requests', async () => {
    const app = new Vajra();
    app.get('/api/data', contentType('json'), (c) => c.json({ ok: true }));

    const res = await app.handle(new Request('http://localhost/api/data'));
    expect(res.status).toBe(200);
  });
});

describe('SSRF Prevention', () => {
  test('blocks localhost', () => {
    expect(isInternalUrl('http://localhost/admin')).toBe(true);
    expect(isInternalUrl('http://127.0.0.1/admin')).toBe(true);
    expect(isInternalUrl('http://127.0.0.2/admin')).toBe(true);
  });

  test('blocks private IPs', () => {
    expect(isInternalUrl('http://10.0.0.1/')).toBe(true);
    expect(isInternalUrl('http://192.168.1.1/')).toBe(true);
    expect(isInternalUrl('http://172.16.0.1/')).toBe(true);
    expect(isInternalUrl('http://172.31.255.255/')).toBe(true);
  });

  test('blocks cloud metadata', () => {
    expect(isInternalUrl('http://169.254.169.254/latest/meta-data/')).toBe(true);
    expect(isInternalUrl('http://metadata.google.internal/')).toBe(true);
  });

  test('blocks .local and .internal hostnames', () => {
    expect(isInternalUrl('http://myservice.local/')).toBe(true);
    expect(isInternalUrl('http://db.internal/')).toBe(true);
  });

  test('allows public URLs', () => {
    expect(isInternalUrl('https://api.example.com/webhook')).toBe(false);
    expect(isInternalUrl('https://github.com')).toBe(false);
  });

  test('blocks invalid URLs', () => {
    expect(isInternalUrl('not-a-url')).toBe(true);
  });

  test('isPrivateIP checks IPv4 ranges', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
    expect(isPrivateIP('192.168.0.1')).toBe(true);
    expect(isPrivateIP('172.16.0.1')).toBe(true);
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateIP('1.1.1.1')).toBe(false);
  });

  test('isPrivateIP checks IPv6', () => {
    expect(isPrivateIP('::1')).toBe(true);
    expect(isPrivateIP('fc00::1')).toBe(true);
    expect(isPrivateIP('fe80::1')).toBe(true);
  });

  test('ssrfGuard middleware blocks internal URLs', async () => {
    const app = new Vajra();
    app.post('/webhook/test', ssrfGuard('url'), (c) => c.json({ ok: true }));

    const res = await app.handle(new Request('http://localhost/webhook/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
    }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.code).toBe('SSRF_BLOCKED');
  });

  test('ssrfGuard allows public URLs', async () => {
    const app = new Vajra();
    app.post('/webhook/test', ssrfGuard('url'), (c) => c.json({ ok: true }));

    const res = await app.handle(new Request('http://localhost/webhook/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://api.stripe.com/v1/webhook' }),
    }));
    expect(res.status).toBe(200);
  });
});

describe('Request ID', () => {
  test('generates request ID', async () => {
    const app = new Vajra();
    app.use(requestId());
    app.get('/test', (c) => c.json({ id: c.get('requestId') }));

    const res = await app.handle(new Request('http://localhost/test'));
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const data = await res.json();
    expect(data.id).toBeTruthy();
  });

  test('uses incoming request ID when trusted', async () => {
    const app = new Vajra();
    app.use(requestId());
    app.get('/test', (c) => c.json({ id: c.get('requestId') }));

    const res = await app.handle(new Request('http://localhost/test', {
      headers: { 'x-request-id': 'my-custom-id-123' },
    }));
    expect(res.headers.get('x-request-id')).toBe('my-custom-id-123');
  });

  test('ignores incoming ID when untrusted', async () => {
    const app = new Vajra();
    app.use(requestId({ trustProxy: false }));
    app.get('/test', (c) => c.json({ id: c.get('requestId') }));

    const res = await app.handle(new Request('http://localhost/test', {
      headers: { 'x-request-id': 'attacker-id' },
    }));
    expect(res.headers.get('x-request-id')).not.toBe('attacker-id');
  });
});
