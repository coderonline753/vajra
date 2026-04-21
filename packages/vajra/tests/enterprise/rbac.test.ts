import { describe, it, expect } from 'bun:test';
import { Vajra, AccessControl, jwt, jwtSign } from '../../src/index';

describe('RBAC', () => {
  const ac = new AccessControl();
  ac.define('viewer', ['read']);
  ac.define('editor', ['read', 'write'], ['viewer']);
  ac.define('admin', ['*']);
  ac.define('moderator', ['read', 'delete'], ['viewer']);

  it('viewer can read', () => {
    expect(ac.can('viewer', 'read')).toBe(true);
    expect(ac.can('viewer', 'write')).toBe(false);
  });

  it('editor inherits viewer permissions', () => {
    expect(ac.can('editor', 'read')).toBe(true);
    expect(ac.can('editor', 'write')).toBe(true);
    expect(ac.can('editor', 'delete')).toBe(false);
  });

  it('admin has wildcard access', () => {
    expect(ac.can('admin', 'read')).toBe(true);
    expect(ac.can('admin', 'anything')).toBe(true);
  });

  it('moderator inherits and adds', () => {
    expect(ac.can('moderator', 'read')).toBe(true);
    expect(ac.can('moderator', 'delete')).toBe(true);
    expect(ac.can('moderator', 'write')).toBe(false);
  });

  it('multi-role check', () => {
    expect(ac.can(['viewer', 'moderator'], 'delete')).toBe(true);
    expect(ac.can(['viewer'], 'delete')).toBe(false);
  });

  it('unknown role has no permissions', () => {
    expect(ac.can('unknown', 'read')).toBe(false);
  });
});

describe('RBAC Middleware', () => {
  const secret = 'test-secret';
  const ac = new AccessControl();
  ac.define('viewer', ['read']);
  ac.define('editor', ['read', 'write']);
  ac.define('admin', ['*']);

  it('require permission allows authorized user', async () => {
    const app = new Vajra();
    app.get('/posts',
      jwt({ secret }),
      ac.require('read')(),
      (c) => c.json({ posts: [] })
    );

    const token = await jwtSign({ role: 'viewer' }, secret, 3600);
    const res = await app.handle(new Request('http://localhost/posts', {
      headers: { authorization: `Bearer ${token}` },
    }));

    expect(res.status).toBe(200);
  });

  it('require permission denies unauthorized user', async () => {
    const app = new Vajra();
    app.post('/posts',
      jwt({ secret }),
      ac.require('write')(),
      (c) => c.json({ created: true })
    );

    const token = await jwtSign({ role: 'viewer' }, secret, 3600);
    const res = await app.handle(new Request('http://localhost/posts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    }));

    expect(res.status).toBe(403);
  });

  it('requireRole checks role directly', async () => {
    const app = new Vajra();
    app.delete('/users/:id',
      jwt({ secret }),
      ac.requireRole('admin')(),
      (c) => c.json({ deleted: true })
    );

    // Editor should be denied
    const editorToken = await jwtSign({ role: 'editor' }, secret, 3600);
    const r1 = await app.handle(new Request('http://localhost/users/1', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${editorToken}` },
    }));
    expect(r1.status).toBe(403);

    // Admin should pass
    const adminToken = await jwtSign({ role: 'admin' }, secret, 3600);
    const r2 = await app.handle(new Request('http://localhost/users/1', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminToken}` },
    }));
    expect(r2.status).toBe(200);
  });

  it('no role in context returns 403', async () => {
    const app = new Vajra();
    app.get('/secret', ac.require('read')(), (c) => c.text('secret'));

    const res = await app.handle(new Request('http://localhost/secret'));
    expect(res.status).toBe(403);
  });
});
