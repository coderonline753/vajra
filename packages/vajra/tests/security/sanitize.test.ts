import { describe, it, expect } from 'bun:test';
import { Vajra, sanitize, sanitizeXss, detectSqlInjection, detectPathTraversal, detectNoSqlInjection } from '../../src/index';

describe('Sanitize Utilities', () => {
  it('sanitizeXss strips script tags', () => {
    expect(sanitizeXss('<script>alert(1)</script>')).toBe('');
    expect(sanitizeXss('hello<script>bad</script>world')).toBe('helloworld');
  });

  it('sanitizeXss strips event handlers', () => {
    expect(sanitizeXss('<img onerror="alert(1)">')).toBe('<img >');
  });

  it('sanitizeXss strips javascript: URIs', () => {
    expect(sanitizeXss('javascript:alert(1)')).toBe('alert(1)');
  });

  it('sanitizeXss strips iframe/svg/embed', () => {
    expect(sanitizeXss('<iframe src="evil"></iframe>')).toBe('');
    expect(sanitizeXss('<svg onload="bad"></svg>')).toBe('');
    expect(sanitizeXss('<embed src="evil">')).toBe('');
  });

  it('detectSqlInjection catches common patterns', () => {
    expect(detectSqlInjection("' OR '1'='1")).toBe(true);
    expect(detectSqlInjection("'; DROP TABLE users--")).toBe(true);
    expect(detectSqlInjection("UNION SELECT * FROM users")).toBe(true);
    expect(detectSqlInjection("1; EXEC xp_cmdshell")).toBe(true);
  });

  it('detectSqlInjection allows normal text', () => {
    expect(detectSqlInjection("O'Brien")).toBe(false);
    expect(detectSqlInjection("it's a test")).toBe(false);
    expect(detectSqlInjection("SELECT your plan")).toBe(false);
    expect(detectSqlInjection("normal text here")).toBe(false);
  });

  it('detectPathTraversal catches patterns', () => {
    expect(detectPathTraversal('../../etc/passwd')).toBe(true);
    expect(detectPathTraversal('%2e%2e%2f')).toBe(true);
    expect(detectPathTraversal('file%00.txt')).toBe(true);
  });

  it('detectPathTraversal allows normal paths', () => {
    expect(detectPathTraversal('/users/123')).toBe(false);
    expect(detectPathTraversal('documents/report.pdf')).toBe(false);
  });

  it('detectNoSqlInjection catches MongoDB operators', () => {
    expect(detectNoSqlInjection({ $gt: '' })).toBe(true);
    expect(detectNoSqlInjection({ $where: 'this.a > 1' })).toBe(true);
    expect(detectNoSqlInjection({ nested: { $ne: null } })).toBe(true);
  });

  it('detectNoSqlInjection allows normal objects', () => {
    expect(detectNoSqlInjection({ name: 'test', age: 25 })).toBe(false);
    expect(detectNoSqlInjection('normal string')).toBe(false);
  });
});

describe('Sanitize Middleware', () => {
  it('blocks XSS in body', async () => {
    const app = new Vajra();
    app.use(sanitize());
    app.post('/data', async (c) => {
      const body = await c.body();
      return c.json({ body });
    });

    const res = await app.handle(new Request('http://localhost/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '<script>alert(1)</script>' }),
    }));

    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.violation.type).toBe('xss');
  });

  it('blocks SQL injection in query', async () => {
    const app = new Vajra();
    app.use(sanitize());
    app.get('/search', (c) => c.json({ q: c.query('q') }));

    const res = await app.handle(new Request("http://localhost/search?q=' OR '1'='1"));
    expect(res.status).toBe(400);
  });

  it('blocks path traversal in params', async () => {
    const app = new Vajra();
    app.use(sanitize());
    app.get('/files/:path', (c) => c.json({ path: c.param('path') }));

    const res = await app.handle(new Request('http://localhost/files/..%2F..%2Fetc%2Fpasswd'));
    expect(res.status).toBe(400);
  });

  it('allows clean requests through', async () => {
    const app = new Vajra();
    app.use(sanitize());
    app.post('/users', async (c) => {
      const body = await c.body<any>();
      return c.json({ name: body.name });
    });

    const res = await app.handle(new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Arjun Kumar' }),
    }));

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.name).toBe('Arjun Kumar');
  });

  it('custom onViolation callback', async () => {
    const app = new Vajra();
    app.use(sanitize({
      onViolation: (c, v) => c.json({ custom: true, type: v.type }, 422),
    }));
    app.post('/data', async (c) => c.json(await c.body()));

    const res = await app.handle(new Request('http://localhost/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ evil: '<script>x</script>' }),
    }));

    expect(res.status).toBe(422);
    const data = await res.json() as any;
    expect(data.custom).toBe(true);
  });
});
