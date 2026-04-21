import { describe, test, expect } from 'bun:test';
import { devPlayground, redactSecrets } from '../src/dev-playground';
import { Context } from '../src/context';

/* ═════════════ REDACT SECRETS ═════════════ */

describe('redactSecrets', () => {
  test('masks password/secret/token keys', () => {
    const out = redactSecrets({
      name: 'app',
      password: 'hunter2',
      api_secret: 'abc',
      token: 'xyz',
      nested: { apiKey: 'private-key', normal: 'keep' },
    });
    expect(out.name).toBe('app');
    expect(out.password).toMatch(/\*\*\*/);
    expect(out.api_secret).toMatch(/\*\*\*/);
    expect(out.token).toMatch(/\*\*\*/);
    expect((out.nested as any).apiKey).toMatch(/\*\*\*/);
    expect((out.nested as any).normal).toBe('keep');
  });

  test('preserves non-sensitive values unchanged', () => {
    const out = redactSecrets({ host: 'localhost', port: 8080, enabled: true });
    expect(out.host).toBe('localhost');
    expect(out.port).toBe(8080);
    expect(out.enabled).toBe(true);
  });
});

/* ═════════════ MIDDLEWARE ═════════════ */

describe('devPlayground middleware', () => {
  async function run(mw: ReturnType<typeof devPlayground>, path: string, headers: Record<string, string> = {}) {
    const ctx = new Context(new Request('http://localhost' + path, { headers }));
    let response: Response | null = null;
    let passedThrough = false;
    const result = await mw(ctx, async () => { passedThrough = true; });
    if (result instanceof Response) response = result;
    return { response, passedThrough, ctx };
  }

  test('passes through non-prefix paths', async () => {
    const mw = devPlayground();
    const { passedThrough } = await run(mw, '/api/users');
    expect(passedThrough).toBe(true);
  });

  test('serves HTML UI at prefix root', async () => {
    const mw = devPlayground();
    const { response } = await run(mw, '/__vajra');
    expect(response!.status).toBe(200);
    expect(response!.headers.get('content-type')).toMatch(/text\/html/);
    const html = await response!.text();
    expect(html).toContain('Vajra Dev Playground');
  });

  test('serves routes.json', async () => {
    const mw = devPlayground({
      routes: () => [
        { method: 'GET', path: '/users', summary: 'List users' },
        { method: 'POST', path: '/users' },
      ],
    });
    const { response } = await run(mw, '/__vajra/routes.json');
    expect(response!.status).toBe(200);
    const data = await response!.json();
    expect(data).toHaveLength(2);
    expect(data[0].summary).toBe('List users');
  });

  test('serves config.json with redaction', async () => {
    const mw = devPlayground({
      configSnapshot: () => ({ host: 'localhost', apiKey: 'SECRET' }),
    });
    const { response } = await run(mw, '/__vajra/config.json');
    const data = await response!.json();
    expect(data.host).toBe('localhost');
    expect(data.apiKey).toMatch(/\*\*\*/);
  });

  test('serves logs.json', async () => {
    const mw = devPlayground({
      logBuffer: () => ['log1', 'log2', 'log3'],
    });
    const { response } = await run(mw, '/__vajra/logs.json');
    const data = await response!.json();
    expect(data.logs).toEqual(['log1', 'log2', 'log3']);
  });

  test('serves health.json', async () => {
    const mw = devPlayground();
    const { response } = await run(mw, '/__vajra/health.json');
    const data = await response!.json();
    expect(data.ok).toBe(true);
    expect(typeof data.uptime).toBe('number');
  });

  test('returns 404 for unknown sub-path', async () => {
    const mw = devPlayground();
    const { response } = await run(mw, '/__vajra/unknown');
    expect(response!.status).toBe(404);
  });

  test('respects custom prefix', async () => {
    const mw = devPlayground({ prefix: '/debug' });
    const { response, passedThrough } = await run(mw, '/debug');
    expect(response!.status).toBe(200);
    expect(passedThrough).toBe(false);
  });

  test('token guard rejects wrong token', async () => {
    const mw = devPlayground({ token: 'secret123' });
    const { response } = await run(mw, '/__vajra/health.json', { 'x-vajra-dev': 'wrong' });
    expect(response!.status).toBe(403);
  });

  test('token guard accepts correct token in header', async () => {
    const mw = devPlayground({ token: 'secret123' });
    const { response } = await run(mw, '/__vajra/health.json', { 'x-vajra-dev': 'secret123' });
    expect(response!.status).toBe(200);
  });

  test('token can be passed via query param', async () => {
    const mw = devPlayground({ token: 'secret123' });
    const { response } = await run(mw, '/__vajra/health.json?token=secret123');
    expect(response!.status).toBe(200);
  });

  test('disabled in production skips all paths', async () => {
    const mw = devPlayground({ enabled: () => false });
    const { passedThrough, response } = await run(mw, '/__vajra');
    expect(passedThrough).toBe(true);
    expect(response).toBeNull();
  });
});
