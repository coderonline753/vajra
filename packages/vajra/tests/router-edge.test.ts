import { describe, it, expect } from 'bun:test';
import { Router } from '../src/router';

describe('Router Edge Cases', () => {
  it('matches root path /', () => {
    const r = new Router<string>();
    r.add('GET', '/', 'root');
    expect(r.match('GET', '/')?.handler).toBe('root');
    expect(r.match('GET', '/anything')).toBeNull();
  });

  it('does not match partial paths', () => {
    const r = new Router<string>();
    r.add('GET', '/users', 'users');
    expect(r.match('GET', '/users')).not.toBeNull();
    expect(r.match('GET', '/users/')).toBeNull();
    expect(r.match('GET', '/users/extra')).toBeNull();
    expect(r.match('GET', '/user')).toBeNull();
  });

  it('handles trailing slash differently', () => {
    const r = new Router<string>();
    r.add('GET', '/about', 'no-slash');
    r.add('GET', '/faq/', 'with-slash');
    expect(r.match('GET', '/about')?.handler).toBe('no-slash');
    expect(r.match('GET', '/faq/')?.handler).toBe('with-slash'); // trailing slash preserved
  });

  it('matches params with special characters in values', () => {
    const r = new Router<string>();
    r.add('GET', '/users/:id', 'user');

    const m1 = r.match('GET', '/users/user-name');
    expect(m1?.params.id).toBe('user-name');

    const m2 = r.match('GET', '/users/user.name');
    expect(m2?.params.id).toBe('user.name');

    const m3 = r.match('GET', '/users/user@name');
    expect(m3?.params.id).toBe('user@name');

    const m4 = r.match('GET', '/users/123_abc');
    expect(m4?.params.id).toBe('123_abc');
  });

  it('does not match param across slashes', () => {
    const r = new Router<string>();
    r.add('GET', '/users/:id', 'user');
    expect(r.match('GET', '/users/42/extra')).toBeNull();
  });

  it('wildcard param captures slashes', () => {
    const r = new Router<string>();
    r.add('GET', '/files/:path*', 'file');

    const m1 = r.match('GET', '/files/a/b/c.txt');
    expect(m1?.params.path).toBe('a/b/c.txt');

    const m2 = r.match('GET', '/files/single');
    expect(m2?.params.path).toBe('single');
  });

  it('handles many routes without conflict', () => {
    const r = new Router<string>();
    r.add('GET', '/a', 'a');
    r.add('GET', '/b', 'b');
    r.add('GET', '/c', 'c');
    r.add('GET', '/a/b', 'ab');
    r.add('GET', '/a/b/c', 'abc');
    r.add('GET', '/a/:id', 'a-param');

    expect(r.match('GET', '/a')?.handler).toBe('a');
    expect(r.match('GET', '/b')?.handler).toBe('b');
    expect(r.match('GET', '/a/b')?.handler).toBe('ab');
    expect(r.match('GET', '/a/b/c')?.handler).toBe('abc');
    expect(r.match('GET', '/a/xyz')?.handler).toBe('a-param');
  });

  it('static route takes priority over param (order-based)', () => {
    const r = new Router<string>();
    r.add('GET', '/users/me', 'me');
    r.add('GET', '/users/:id', 'user');

    expect(r.match('GET', '/users/me')?.handler).toBe('me');
    expect(r.match('GET', '/users/42')?.handler).toBe('user');
  });

  it('handles empty param value edge case', () => {
    const r = new Router<string>();
    r.add('GET', '/users/:id', 'user');
    // Empty segment won't match :id pattern ([^/]+) needs at least 1 char
    expect(r.match('GET', '/users/')).toBeNull();
  });

  it('handles encoded URL characters', () => {
    const r = new Router<string>();
    r.add('GET', '/search/:query', 'search');
    const m = r.match('GET', '/search/hello%20world');
    expect(m?.params.query).toBe('hello world'); // auto-decoded
  });

  it('same path different methods are independent', () => {
    const r = new Router<string>();
    r.add('GET', '/items', 'get-items');
    r.add('POST', '/items', 'post-items');
    r.add('PUT', '/items/:id', 'put-item');
    r.add('DELETE', '/items/:id', 'delete-item');
    r.add('PATCH', '/items/:id', 'patch-item');

    expect(r.match('GET', '/items')?.handler).toBe('get-items');
    expect(r.match('POST', '/items')?.handler).toBe('post-items');
    expect(r.match('PUT', '/items/1')?.handler).toBe('put-item');
    expect(r.match('DELETE', '/items/1')?.handler).toBe('delete-item');
    expect(r.match('PATCH', '/items/1')?.handler).toBe('patch-item');
    expect(r.match('HEAD', '/items')).toBeNull();
  });

  it('handles 50 routes without breaking', () => {
    const r = new Router<number>();
    for (let i = 0; i < 50; i++) {
      r.add('GET', `/route${i}/:id`, i);
    }

    expect(r.match('GET', '/route0/abc')?.handler).toBe(0);
    expect(r.match('GET', '/route25/abc')?.handler).toBe(25);
    expect(r.match('GET', '/route49/abc')?.handler).toBe(49);
    expect(r.match('GET', '/route50/abc')).toBeNull();
  });
});
