import { describe, test, expect } from 'bun:test';
import { Vajra } from '../../src/vajra';
import { defineRoute, createElement as jsx, Fragment, island, atom, computed, renderHead } from '../../src/ssr';

describe('SSR Integration with Vajra App', () => {
  test('app.page() registers SSR route', async () => {
    const app = new Vajra();

    const homePage = defineRoute({
      render() {
        return jsx('div', {}, 'Hello SSR');
      },
    });

    app.page('/', homePage);

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('Hello SSR');
    expect(html).toContain('<!DOCTYPE html>');
  });

  test('SSR route with loader data', async () => {
    const app = new Vajra();

    const page = defineRoute({
      async load() {
        return { title: 'Vajra', version: '0.2.0' };
      },
      render({ data }) {
        return jsx('div', {},
          jsx('h1', {}, data.title),
          jsx('span', {}, `v${data.version}`)
        );
      },
    });

    app.page('/about', page);

    const res = await app.handle(new Request('http://localhost/about'));
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('<h1>Vajra</h1>');
    expect(html).toContain('v0.2.0');
  });

  test('SSR route with meta/head tags', async () => {
    const app = new Vajra();

    const page = defineRoute({
      async load() {
        return { name: 'Product X' };
      },
      meta({ data }) {
        return {
          title: data.name,
          description: 'Best product ever',
          openGraph: { title: data.name, type: 'product' },
        };
      },
      render({ data }) {
        return jsx('h1', {}, data.name);
      },
    });

    app.page('/product', page);

    const res = await app.handle(new Request('http://localhost/product'));
    const html = await res.text();

    expect(html).toContain('<title>Product X</title>');
    expect(html).toContain('og:title');
    expect(html).toContain('og:type');
    expect(html).toContain('<h1>Product X</h1>');
  });

  test('SSR route with params', async () => {
    const app = new Vajra();

    const page = defineRoute({
      async load({ params }) {
        return { id: params.id };
      },
      render({ data }) {
        return jsx('div', {}, `Product ID: ${data.id}`);
      },
    });

    app.page('/products/:id', page);

    const res = await app.handle(new Request('http://localhost/products/42'));
    const html = await res.text();
    expect(html).toContain('Product ID: 42');
  });

  test('SSR route with cache headers', async () => {
    const app = new Vajra();

    const page = defineRoute({
      render() {
        return jsx('div', {}, 'Cached Page');
      },
      cache: { type: 'swr', maxAge: 60, staleWhileRevalidate: 300 },
    });

    app.page('/cached', page);

    const res = await app.handle(new Request('http://localhost/cached'));
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=300');
  });

  test('SSR route with non-streaming mode', async () => {
    const app = new Vajra();

    const page = defineRoute({
      render() {
        return jsx('div', {}, 'Static Render');
      },
      streaming: false,
    });

    app.page('/static', page);

    const res = await app.handle(new Request('http://localhost/static'));
    const html = await res.text();
    expect(html).toContain('Static Render');
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test('SSR route notFound throws 404', async () => {
    const app = new Vajra();

    const page = defineRoute({
      async load({ notFound }) {
        notFound();
        return {};
      },
      render() {
        return jsx('div', {}, 'Never renders');
      },
    });

    app.page('/missing', page);

    const res = await app.handle(new Request('http://localhost/missing'));
    expect(res.status).toBe(404);
  });

  test('SSR route redirect', async () => {
    const app = new Vajra();

    const page = defineRoute({
      async load({ redirect }) {
        redirect('/login');
        return {};
      },
      render() {
        return jsx('div', {}, 'Never renders');
      },
    });

    app.page('/protected', page);

    const res = await app.handle(new Request('http://localhost/protected'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  test('SSR route action handles POST', async () => {
    const app = new Vajra();

    const page = defineRoute({
      async action({ redirect }) {
        // Process form...
        redirect('/success');
        return {};
      },
      render() {
        return jsx('form', { method: 'POST' },
          jsx('input', { type: 'text', name: 'title' }),
          jsx('button', { type: 'submit' }, 'Submit')
        );
      },
    });

    app.page('/form', page);

    const res = await app.handle(new Request('http://localhost/form', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Test' }),
    }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/success');
  });

  test('SSR route with custom error render', async () => {
    const app = new Vajra();

    const page = defineRoute({
      async load() {
        throw new Error('Database down');
      },
      render() {
        return jsx('div', {}, 'Content');
      },
      errorRender({ error }) {
        return jsx('div', { className: 'error' }, `Error: ${error.message}`);
      },
    });

    app.page('/broken', page);

    const res = await app.handle(new Request('http://localhost/broken'));
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain('Error: Database down');
  });

  test('async component renders correctly', async () => {
    const app = new Vajra();

    const AsyncWidget = async () => {
      const data = await Promise.resolve('Async Data');
      return jsx('span', {}, data);
    };

    const page = defineRoute({
      render() {
        return jsx('div', {},
          jsx('h1', {}, 'Page'),
          jsx(AsyncWidget, {})
        );
      },
    });

    app.page('/async', page);

    const res = await app.handle(new Request('http://localhost/async'));
    const html = await res.text();
    expect(html).toContain('Async Data');
  });

  test('island renders with hydration markers', async () => {
    const app = new Vajra();

    const Counter = island('Counter', (props: any) => {
      return jsx('button', {}, `Count: ${props.start || 0}`);
    }, { hydrate: 'visible' });

    const page = defineRoute({
      render() {
        return jsx('div', {},
          jsx('h1', {}, 'Interactive Page'),
          jsx(Counter, { start: 5 })
        );
      },
    });

    app.page('/interactive', page);

    const res = await app.handle(new Request('http://localhost/interactive'));
    const html = await res.text();
    expect(html).toContain('Interactive Page');
    expect(html).toContain('data-island="Counter"');
    expect(html).toContain('data-hydrate="visible"');
    expect(html).toContain('Count: 5');
  });

  test('reactive store works across operations', () => {
    const count = atom(0);
    const doubled = computed(count, v => v * 2);

    count.set(5);
    expect(count.get()).toBe(5);
    expect(doubled.get()).toBe(10);

    count.set(10);
    expect(doubled.get()).toBe(20);
  });

  test('Vajra app works with both API and SSR routes', async () => {
    const app = new Vajra();

    // API route
    app.get('/api/users', (c) => c.json({ users: ['Alice', 'Bob'] }));

    // SSR page
    const page = defineRoute({
      render() {
        return jsx('h1', {}, 'Users Page');
      },
    });
    app.page('/users', page);

    // Test API
    const apiRes = await app.handle(new Request('http://localhost/api/users'));
    expect(apiRes.status).toBe(200);
    const apiData = await apiRes.json();
    expect(apiData.users).toEqual(['Alice', 'Bob']);

    // Test SSR
    const ssrRes = await app.handle(new Request('http://localhost/users'));
    expect(ssrRes.status).toBe(200);
    const html = await ssrRes.text();
    expect(html).toContain('Users Page');
  });
});
