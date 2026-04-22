import { describe, test, expect } from 'bun:test';
import { createElement as jsx, Fragment, Suspense } from '../../src/ssr/jsx-runtime';
import { renderToString, renderToStream } from '../../src/ssr/renderer';

describe('renderToString', () => {
  test('renders simple HTML element', async () => {
    const html = await renderToString(jsx('div', {}, 'Hello'));
    expect(html).toBe('<div>Hello</div>');
  });

  test('renders nested elements', async () => {
    const html = await renderToString(
      jsx('div', { className: 'wrapper' },
        jsx('h1', {}, 'Title'),
        jsx('p', {}, 'Content')
      )
    );
    expect(html).toBe('<div class="wrapper"><h1>Title</h1><p>Content</p></div>');
  });

  test('renders void elements', async () => {
    const html = await renderToString(jsx('br', {}));
    expect(html).toBe('<br />');
  });

  test('renders void elements with attributes', async () => {
    const html = await renderToString(jsx('img', { src: '/photo.jpg', alt: 'Photo' }));
    expect(html).toBe('<img src="/photo.jpg" alt="Photo" />');
  });

  test('renders Fragment', async () => {
    const html = await renderToString(
      jsx(Fragment, {},
        jsx('span', {}, 'A'),
        jsx('span', {}, 'B')
      )
    );
    expect(html).toBe('<span>A</span><span>B</span>');
  });

  test('renders sync component', async () => {
    const Greeting = (props: any) => jsx('h1', {}, `Hello ${props.name}`);
    const html = await renderToString(jsx(Greeting, { name: 'Vajra' }));
    expect(html).toBe('<h1>Hello Vajra</h1>');
  });

  test('renders async component', async () => {
    const AsyncData = async () => {
      const data = await Promise.resolve('Loaded');
      return jsx('p', {}, data);
    };
    const html = await renderToString(jsx(AsyncData, {}));
    expect(html).toBe('<p>Loaded</p>');
  });

  test('renders nested async components', async () => {
    const Inner = async () => {
      return jsx('span', {}, 'inner');
    };
    const Outer = async () => {
      return jsx('div', {}, jsx(Inner, {}));
    };
    const html = await renderToString(jsx(Outer, {}));
    expect(html).toBe('<div><span>inner</span></div>');
  });

  test('renders number children', async () => {
    const html = await renderToString(jsx('span', {}, 42));
    expect(html).toBe('<span>42</span>');
  });

  test('escapes HTML in text children', async () => {
    const html = await renderToString(jsx('div', {}, '<script>alert("xss")</script>'));
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  test('renders dangerouslySetInnerHTML', async () => {
    const html = await renderToString(
      jsx('div', { dangerouslySetInnerHTML: { __html: '<strong>Bold</strong>' } })
    );
    expect(html).toBe('<div><strong>Bold</strong></div>');
  });

  test('renders component with children prop', async () => {
    const Layout = (props: any) => jsx('main', {}, props.children);
    const html = await renderToString(
      jsx(Layout, {}, jsx('p', {}, 'Content'))
    );
    expect(html).toBe('<main><p>Content</p></main>');
  });

  test('renders null and undefined as empty', async () => {
    expect(await renderToString(null)).toBe('');
  });

  test('renders string', async () => {
    const html = await renderToString('Hello' as any);
    expect(html).toBe('Hello');
  });

  test('renders Suspense with resolved children', async () => {
    const fallback = jsx('span', {}, 'Loading...');
    const AsyncContent = async () => {
      return jsx('div', {}, 'Loaded!');
    };
    const html = await renderToString(
      Suspense({ fallback, children: jsx(AsyncContent, {}) })
    );
    expect(html).toBe('<div>Loaded!</div>');
  });

  test('renders boolean attributes correctly', async () => {
    const html = await renderToString(jsx('input', { type: 'checkbox', checked: true, disabled: true }));
    expect(html).toContain('checked');
    expect(html).toContain('disabled');
  });
});

describe('renderToStream', () => {
  test('streams simple HTML', async () => {
    const stream = renderToStream(jsx('div', {}, 'Hello'));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value);
    }
    expect(html).toContain('<div>Hello</div>');
  });

  test('streams with Suspense fallback then resolved content', async () => {
    const fallback = jsx('span', {}, 'Loading...');
    const AsyncContent = async () => {
      await new Promise(r => setTimeout(r, 10));
      return jsx('div', {}, 'Done!');
    };

    const stream = renderToStream(
      jsx('div', {},
        Suspense({ fallback, children: jsx(AsyncContent, {}) })
      )
    );

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value);
    }

    // Should contain the fallback in initial shell
    expect(html).toContain('Loading...');
    // Should contain the resolved content as a streamed script
    expect(html).toContain('Done!');
    expect(html).toContain('vajra_sr');
  });

  test('includes bootstrap scripts', async () => {
    const stream = renderToStream(
      jsx('div', {}, 'App'),
      { bootstrapModules: ['/app.js'] }
    );

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value);
    }

    expect(html).toContain('type="module" src="/app.js"');
  });
});
