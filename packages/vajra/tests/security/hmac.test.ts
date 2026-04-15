import { describe, it, expect } from 'bun:test';
import { Vajra, hmacVerify, computeHmac, verifyHmac } from '../../src/index';

describe('HMAC Utilities', () => {
  const secret = 'webhook-secret-key';

  it('computeHmac produces consistent results', async () => {
    const sig1 = await computeHmac('hello', secret);
    const sig2 = await computeHmac('hello', secret);
    expect(sig1).toBe(sig2);
    expect(sig1.length).toBe(64); // SHA-256 hex = 64 chars
  });

  it('different payloads produce different signatures', async () => {
    const sig1 = await computeHmac('hello', secret);
    const sig2 = await computeHmac('world', secret);
    expect(sig1).not.toBe(sig2);
  });

  it('verifyHmac validates correct signature', async () => {
    const signature = await computeHmac('test-payload', secret);
    const valid = await verifyHmac('test-payload', secret, signature);
    expect(valid).toBe(true);
  });

  it('verifyHmac rejects wrong signature', async () => {
    const valid = await verifyHmac('test-payload', secret, 'wrong-signature');
    expect(valid).toBe(false);
  });

  it('SHA-512 produces longer signature', async () => {
    const sig = await computeHmac('hello', secret, 'SHA-512');
    expect(sig.length).toBe(128); // SHA-512 hex = 128 chars
  });
});

describe('HMAC Middleware', () => {
  const secret = 'webhook-secret';

  it('valid signature passes', async () => {
    const app = new Vajra();
    const body = '{"event":"push"}';
    const signature = await computeHmac(body, secret);

    app.post('/webhook', hmacVerify({ secret }), async (c) => {
      return c.json({ ok: true });
    });

    const res = await app.handle(new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-256': `sha256=${signature}`,
      },
      body,
    }));

    expect(res.status).toBe(200);
  });

  it('missing signature returns 403', async () => {
    const app = new Vajra();
    app.post('/webhook', hmacVerify({ secret }), async (c) => c.json({ ok: true }));

    const res = await app.handle(new Request('http://localhost/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"event":"push"}',
    }));

    expect(res.status).toBe(403);
  });

  it('invalid signature returns 403', async () => {
    const app = new Vajra();
    app.post('/webhook', hmacVerify({ secret }), async (c) => c.json({ ok: true }));

    const res = await app.handle(new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-256': 'sha256=invalid',
      },
      body: '{"event":"push"}',
    }));

    expect(res.status).toBe(403);
  });

  it('custom header name works', async () => {
    const app = new Vajra();
    const body = 'test';
    const signature = await computeHmac(body, secret);

    app.post('/hook', hmacVerify({ secret, header: 'x-hub-signature', prefix: '' }), async (c) => {
      return c.json({ ok: true });
    });

    const res = await app.handle(new Request('http://localhost/hook', {
      method: 'POST',
      headers: { 'x-hub-signature': signature },
      body,
    }));

    expect(res.status).toBe(200);
  });

  it('rawBody is stored in context', async () => {
    const app = new Vajra();
    const body = '{"data":"test"}';
    const signature = await computeHmac(body, secret);

    app.post('/webhook', hmacVerify({ secret }), async (c) => {
      const rawBody = c.get<string>('rawBody');
      return c.json({ rawBody });
    });

    const res = await app.handle(new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-256': `sha256=${signature}`,
      },
      body,
    }));

    const data = await res.json() as any;
    expect(data.rawBody).toBe(body);
  });
});
