import { describe, it, expect } from 'bun:test';
import { Vajra, csrf } from '../../src/index';

describe('CSRF', () => {
  it('GET request gets a CSRF cookie', async () => {
    const app = new Vajra();
    app.use(csrf());
    app.get('/', (c) => c.json({ token: c.get('csrfToken') }));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('_csrf=');
    const data = await res.json() as any;
    expect(data.token).toBeTruthy();
  });

  it('POST without token returns 403', async () => {
    const app = new Vajra();
    app.use(csrf());
    app.post('/submit', (c) => c.json({ ok: true }));

    const res = await app.handle(new Request('http://localhost/submit', {
      method: 'POST',
      headers: { cookie: '_csrf=test-token-123' },
    }));
    expect(res.status).toBe(403);
  });

  it('POST with matching token succeeds', async () => {
    const app = new Vajra();
    app.use(csrf());
    app.post('/submit', (c) => c.json({ ok: true }));

    const token = 'valid-csrf-token-12345';
    const res = await app.handle(new Request('http://localhost/submit', {
      method: 'POST',
      headers: {
        cookie: `_csrf=${token}`,
        'x-csrf-token': token,
      },
    }));
    expect(res.status).toBe(200);
  });

  it('POST with mismatched token returns 403', async () => {
    const app = new Vajra();
    app.use(csrf());
    app.post('/submit', (c) => c.json({ ok: true }));

    const res = await app.handle(new Request('http://localhost/submit', {
      method: 'POST',
      headers: {
        cookie: '_csrf=token-a',
        'x-csrf-token': 'token-b',
      },
    }));
    expect(res.status).toBe(403);
  });

  it('excluded paths bypass CSRF', async () => {
    const app = new Vajra();
    app.use(csrf({ excludePaths: ['/api/webhook'] }));
    app.post('/api/webhook', (c) => c.json({ ok: true }));

    const res = await app.handle(new Request('http://localhost/api/webhook', { method: 'POST' }));
    expect(res.status).toBe(200);
  });

  it('safe methods skip validation', async () => {
    const app = new Vajra();
    app.use(csrf());
    app.get('/data', (c) => c.text('ok'));
    app.head('/data', (c) => c.empty());

    const res = await app.handle(new Request('http://localhost/data'));
    expect(res.status).toBe(200);
  });

  it('custom cookie and header names', async () => {
    const app = new Vajra();
    app.use(csrf({ cookie: 'my-csrf', header: 'x-my-token' }));
    app.post('/submit', (c) => c.json({ ok: true }));

    const token = 'custom-token-abc';
    const res = await app.handle(new Request('http://localhost/submit', {
      method: 'POST',
      headers: {
        cookie: `my-csrf=${token}`,
        'x-my-token': token,
      },
    }));
    expect(res.status).toBe(200);
  });
});
