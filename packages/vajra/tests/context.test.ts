import { describe, it, expect } from 'bun:test';
import { Context } from '../src/context';

describe('Context', () => {
  it('returns JSON response', () => {
    const req = new Request('http://localhost/test');
    const c = new Context(req);
    const res = c.json({ ok: true });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('returns JSON with custom status', () => {
    const req = new Request('http://localhost/test');
    const c = new Context(req);
    const res = c.json({ created: true }, 201);

    expect(res.status).toBe(201);
  });

  it('returns text response', () => {
    const req = new Request('http://localhost/test');
    const c = new Context(req);
    const res = c.text('hello');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('returns HTML response', () => {
    const req = new Request('http://localhost/test');
    const c = new Context(req);
    const res = c.html('<h1>Hello</h1>');

    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('reads route params', () => {
    const req = new Request('http://localhost/users/42');
    const c = new Context(req, { id: '42' });

    expect(c.param('id')).toBe('42');
    expect(c.params.id).toBe('42');
  });

  it('reads query params', () => {
    const req = new Request('http://localhost/search?q=vajra&page=2');
    const c = new Context(req);

    expect(c.query('q')).toBe('vajra');
    expect(c.query('page')).toBe('2');
    expect(c.query('missing')).toBeNull();
  });

  it('reads all queries as object', () => {
    const req = new Request('http://localhost/search?q=vajra&page=2');
    const c = new Context(req);

    expect(c.queries).toEqual({ q: 'vajra', page: '2' });
  });

  it('reads request headers', () => {
    const req = new Request('http://localhost/test', {
      headers: { 'x-custom': 'value' },
    });
    const c = new Context(req);

    expect(c.header('x-custom')).toBe('value');
  });

  it('provides method and path', () => {
    const req = new Request('http://localhost/api/users', { method: 'POST' });
    const c = new Context(req);

    expect(c.method).toBe('POST');
    expect(c.path).toBe('/api/users');
  });

  it('stores and retrieves middleware data', () => {
    const req = new Request('http://localhost/test');
    const c = new Context(req);

    c.set('user', { id: 1, name: 'Arjun' });
    expect(c.get('user')).toEqual({ id: 1, name: 'Arjun' });
    expect(c.get('missing')).toBeUndefined();
  });

  it('chains status and setHeader', () => {
    const req = new Request('http://localhost/test');
    const c = new Context(req);
    const res = c.status(201).setHeader('x-req-id', 'abc').json({ ok: true });

    expect(res.status).toBe(201);
    expect(res.headers.get('x-req-id')).toBe('abc');
  });

  it('returns redirect', () => {
    const req = new Request('http://localhost/old');
    const c = new Context(req);
    const res = c.redirect('/new');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/new');
  });

  it('returns empty response', () => {
    const req = new Request('http://localhost/test');
    const c = new Context(req);
    const res = c.empty();

    expect(res.status).toBe(204);
  });

  it('parses JSON body', async () => {
    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Vajra' }),
    });
    const c = new Context(req);
    const body = await c.body<{ name: string }>();

    expect(body.name).toBe('Vajra');
  });
});
