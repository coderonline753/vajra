import { describe, it, expect } from 'bun:test';
import { Router } from '../src/router';

describe('Router', () => {
  it('matches static routes', () => {
    const router = new Router<string>();
    router.add('GET', '/', 'home');
    router.add('GET', '/about', 'about');
    router.add('GET', '/users', 'users');

    expect(router.match('GET', '/')?.handler).toBe('home');
    expect(router.match('GET', '/about')?.handler).toBe('about');
    expect(router.match('GET', '/users')?.handler).toBe('users');
    expect(router.match('GET', '/nope')).toBeNull();
  });

  it('matches parameterized routes', () => {
    const router = new Router<string>();
    router.add('GET', '/users/:id', 'user');
    router.add('GET', '/posts/:postId/comments/:commentId', 'comment');

    const m1 = router.match('GET', '/users/42');
    expect(m1?.handler).toBe('user');
    expect(m1?.params.id).toBe('42');

    const m2 = router.match('GET', '/posts/10/comments/5');
    expect(m2?.handler).toBe('comment');
    expect(m2?.params.postId).toBe('10');
    expect(m2?.params.commentId).toBe('5');
  });

  it('matches wildcard routes', () => {
    const router = new Router<string>();
    router.add('GET', '/files/:path*', 'file');

    const m = router.match('GET', '/files/docs/readme.md');
    expect(m?.handler).toBe('file');
    expect(m?.params.path).toBe('docs/readme.md');
  });

  it('differentiates HTTP methods', () => {
    const router = new Router<string>();
    router.add('GET', '/users', 'list');
    router.add('POST', '/users', 'create');
    router.add('DELETE', '/users/:id', 'delete');

    expect(router.match('GET', '/users')?.handler).toBe('list');
    expect(router.match('POST', '/users')?.handler).toBe('create');
    expect(router.match('DELETE', '/users/5')?.handler).toBe('delete');
    expect(router.match('PUT', '/users')).toBeNull();
  });

  it('returns null for unmatched routes', () => {
    const router = new Router<string>();
    router.add('GET', '/home', 'home');

    expect(router.match('GET', '/other')).toBeNull();
    expect(router.match('POST', '/home')).toBeNull();
  });

  it('handles multiple params correctly', () => {
    const router = new Router<string>();
    router.add('GET', '/api/:version/users/:id', 'handler');

    const m = router.match('GET', '/api/v1/users/abc');
    expect(m?.handler).toBe('handler');
    expect(m?.params.version).toBe('v1');
    expect(m?.params.id).toBe('abc');
  });
});
