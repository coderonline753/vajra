import { describe, it, expect } from 'bun:test';
import { Vajra } from '../src/vajra';

describe('Vajra App', () => {
  it('handles GET request', async () => {
    const app = new Vajra();
    app.get('/', (c) => c.text('Hello Vajra'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello Vajra');
  });

  it('handles POST with JSON', async () => {
    const app = new Vajra();
    app.post('/users', async (c) => {
      const body = await c.body<{ name: string }>();
      return c.json({ created: body.name }, 201);
    });

    const res = await app.handle(new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Arjun' }),
    }));

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.created).toBe('Arjun');
  });

  it('extracts route params', async () => {
    const app = new Vajra();
    app.get('/users/:id', (c) => c.json({ id: c.param('id') }));

    const res = await app.handle(new Request('http://localhost/users/42'));
    const data = await res.json();
    expect(data.id).toBe('42');
  });

  it('returns 404 for unmatched routes', async () => {
    const app = new Vajra();
    app.get('/', (c) => c.text('home'));

    const res = await app.handle(new Request('http://localhost/nope'));
    expect(res.status).toBe(404);
  });

  it('runs global middleware', async () => {
    const app = new Vajra();
    app.use(async (c, next) => {
      c.set('before', true);
      const res = await next();
      res.headers.set('x-powered-by', 'Vajra');
      return res;
    });
    app.get('/', (c) => c.json({ before: c.get('before') }));

    const res = await app.handle(new Request('http://localhost/'));
    const data = await res.json();
    expect(data.before).toBe(true);
    expect(res.headers.get('x-powered-by')).toBe('Vajra');
  });

  it('runs route-level middleware', async () => {
    const app = new Vajra();
    const authMiddleware = async (c: any, next: any) => {
      c.set('authed', true);
      return next();
    };

    app.get('/protected', authMiddleware, (c) => {
      return c.json({ authed: c.get('authed') });
    });

    const res = await app.handle(new Request('http://localhost/protected'));
    const data = await res.json();
    expect(data.authed).toBe(true);
  });

  it('handles route groups', async () => {
    const app = new Vajra();
    app.group('/api/v1', (g) => {
      g.get('/users', (c) => c.json({ route: 'users' }));
      g.get('/posts', (c) => c.json({ route: 'posts' }));
    });

    const r1 = await app.handle(new Request('http://localhost/api/v1/users'));
    expect((await r1.json()).route).toBe('users');

    const r2 = await app.handle(new Request('http://localhost/api/v1/posts'));
    expect((await r2.json()).route).toBe('posts');
  });

  it('handles object-style route config', async () => {
    const app = new Vajra();
    app.route({
      method: 'POST',
      path: '/items',
      handler: (c) => c.json({ method: 'object-style' }, 201),
    });

    const res = await app.handle(new Request('http://localhost/items', { method: 'POST' }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.method).toBe('object-style');
  });

  it('catches errors and returns 500', async () => {
    const app = new Vajra();
    app.get('/error', () => {
      throw new Error('test error');
    });

    const res = await app.handle(new Request('http://localhost/error'));
    expect(res.status).toBe(500);
  });

  it('supports custom error handler', async () => {
    const app = new Vajra();
    app.onError((err, c) => c.json({ custom: err.message }, 500));
    app.get('/error', () => { throw new Error('oops'); });

    const res = await app.handle(new Request('http://localhost/error'));
    const data = await res.json();
    expect(data.custom).toBe('oops');
  });

  it('supports custom 404 handler', async () => {
    const app = new Vajra();
    app.onNotFound((c) => c.json({ custom: 'not here' }, 404));

    const res = await app.handle(new Request('http://localhost/missing'));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.custom).toBe('not here');
  });
});
