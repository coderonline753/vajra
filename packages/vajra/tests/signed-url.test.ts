import { describe, test, expect } from 'bun:test';
import {
  createSigner,
  createMemoryUsageStore,
  createRedisUsageStore,
  type RedisUsageClient,
} from '../src/signed-url';
import { Context } from '../src/context';

const SECRET = 'signed-url-secret-xyz';

describe('createSigner · sign/verify roundtrip', () => {
  test('sign returns path with signature query param', async () => {
    const s = createSigner({ secret: SECRET });
    const url = await s.sign('/downloads/report.pdf', { expiresIn: 60 });
    expect(url).toContain('/downloads/report.pdf');
    expect(url).toContain('sig=');
  });

  test('verify accepts valid signature', async () => {
    const s = createSigner({ secret: SECRET });
    const url = await s.sign('/files/x.zip', { expiresIn: 60 });
    const [path, query] = url.split('?');
    const params = new URLSearchParams(query);

    const result = await s.verify(path!, params, 'GET');
    expect(result.valid).toBe(true);
    expect(result.path).toBe('/files/x.zip');
    expect(result.method).toBe('GET');
  });

  test('verify rejects missing signature', async () => {
    const s = createSigner({ secret: SECRET });
    const result = await s.verify('/x', new URLSearchParams(), 'GET');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing');
  });

  test('verify rejects tampered signature', async () => {
    const s = createSigner({ secret: SECRET });
    const url = await s.sign('/x', { expiresIn: 60 });
    const params = new URLSearchParams(url.split('?')[1]!);
    // Tamper: prepend junk
    const original = params.get('sig')!;
    params.set('sig', 'AAAA' + original.slice(4));
    const result = await s.verify('/x', params, 'GET');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('tampered');
  });

  test('verify rejects expired URL', async () => {
    const s = createSigner({ secret: SECRET });
    const url = await s.sign('/x', { expiresIn: -1 });
    const params = new URLSearchParams(url.split('?')[1]!);
    const result = await s.verify('/x', params, 'GET');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  test('verify rejects wrong method', async () => {
    const s = createSigner({ secret: SECRET });
    const url = await s.sign('/x', { method: 'GET', expiresIn: 60 });
    const params = new URLSearchParams(url.split('?')[1]!);
    const result = await s.verify('/x', params, 'POST');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('method');
  });

  test('verify rejects path mismatch', async () => {
    const s = createSigner({ secret: SECRET });
    const url = await s.sign('/a', { expiresIn: 60 });
    const params = new URLSearchParams(url.split('?')[1]!);
    const result = await s.verify('/b', params, 'GET');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('path');
  });

  test('verify rejects wrong secret', async () => {
    const signer1 = createSigner({ secret: 'secret-a' });
    const signer2 = createSigner({ secret: 'secret-b' });
    const url = await signer1.sign('/x', { expiresIn: 60 });
    const params = new URLSearchParams(url.split('?')[1]!);
    const result = await signer2.verify('/x', params, 'GET');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('tampered');
  });
});

describe('createSigner · claims', () => {
  test('claims roundtrip through signing', async () => {
    const s = createSigner({ secret: SECRET });
    const url = await s.sign('/download', {
      expiresIn: 60,
      claims: { userId: 42, plan: 'pro', trusted: true },
    });
    const params = new URLSearchParams(url.split('?')[1]!);
    const result = await s.verify('/download', params, 'GET');
    expect(result.valid).toBe(true);
    expect(result.claims?.userId).toBe(42);
    expect(result.claims?.plan).toBe('pro');
    expect(result.claims?.trusted).toBe(true);
  });
});

describe('createSigner · maxUses', () => {
  test('limits redemptions using memory store', async () => {
    const usageStore = createMemoryUsageStore();
    const s = createSigner({ secret: SECRET, usageStore });
    const url = await s.sign('/one-shot', { expiresIn: 60, maxUses: 2 });
    const params = new URLSearchParams(url.split('?')[1]!);

    expect((await s.verify('/one-shot', params, 'GET')).valid).toBe(true);
    expect((await s.verify('/one-shot', params, 'GET')).valid).toBe(true);
    const third = await s.verify('/one-shot', params, 'GET');
    expect(third.valid).toBe(false);
    expect(third.reason).toBe('exhausted');
  });

  test('throws helpful error when maxUses set without store', async () => {
    const s = createSigner({ secret: SECRET });
    const url = await s.sign('/x', { expiresIn: 60, maxUses: 1 });
    const params = new URLSearchParams(url.split('?')[1]!);
    expect(s.verify('/x', params, 'GET')).rejects.toThrow(/requires a usageStore/);
  });

  test('Redis usage store integration', async () => {
    const data = new Map<string, { value: number; expiresAt: number }>();
    const redis: RedisUsageClient = {
      async incr(key) {
        const now = Date.now();
        let entry = data.get(key);
        if (!entry || entry.expiresAt < now) {
          entry = { value: 0, expiresAt: now + 300_000 };
          data.set(key, entry);
        }
        return ++entry.value;
      },
      async expire(key, seconds) {
        const entry = data.get(key);
        if (entry) entry.expiresAt = Date.now() + seconds * 1000;
        return 1;
      },
    };

    const usageStore = createRedisUsageStore(redis);
    const s = createSigner({ secret: SECRET, usageStore });
    const url = await s.sign('/premium', { expiresIn: 60, maxUses: 1 });
    const params = new URLSearchParams(url.split('?')[1]!);

    expect((await s.verify('/premium', params, 'GET')).valid).toBe(true);
    const second = await s.verify('/premium', params, 'GET');
    expect(second.valid).toBe(false);
  });
});

describe('createSigner · middleware', () => {
  test('passes through on valid signature', async () => {
    const s = createSigner({ secret: SECRET });
    const url = await s.sign('/api/files/1', { expiresIn: 60, claims: { userId: 7 } });
    const ctx = new Context(new Request('http://localhost' + url));

    let claimsReceived: any = null;
    await s.middleware()(ctx, async () => {
      claimsReceived = ctx.get('signedUrlClaims');
    });
    expect(claimsReceived).toEqual({ userId: 7 });
  });

  test('returns 403 on invalid signature', async () => {
    const s = createSigner({ secret: SECRET });
    const ctx = new Context(new Request('http://localhost/api/files/2'));

    const result = await s.middleware()(ctx, async () => {
      throw new Error('should not reach handler');
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });
});

describe('createSigner · custom param name', () => {
  test('respects paramName option', async () => {
    const s = createSigner({ secret: SECRET, paramName: 'token' });
    const url = await s.sign('/x', { expiresIn: 60 });
    expect(url).toContain('token=');
    expect(url).not.toContain('sig=');
  });
});
