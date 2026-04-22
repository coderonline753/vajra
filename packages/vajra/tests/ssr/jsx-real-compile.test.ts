import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { jsx, jsxDEV, jsxs, Fragment } from '../../src/ssr/jsx-runtime';
import { renderToString } from '../../src/ssr/renderer';

/**
 * End-to-end regression test for the v1.2.0 jsxDEV signature bug
 * (see bug_vajra_ssr_jsxdev memo).
 *
 * Strategy:
 *   1. Hand a real TSX snippet to Bun.Transpiler (the same transformer Bun uses
 *      when loading .tsx files at runtime).
 *   2. Bun emits 6-arg `jsxDEV(type, props, key, isStatic, src, self)` calls
 *      using a hashed local identifier and an injected import to
 *      `vajrajs/jsx-dev-runtime`.
 *   3. We rewrite the hashed identifier and the injected import so the
 *      generated module loads against THIS package's runtime without depending
 *      on a published-package symlink.
 *   4. Import via a `data:` URL, render the exported tree, assert nested JSX
 *      children survive — which is exactly what the bug broke.
 */

const transpiler = new Bun.Transpiler({
  loader: 'tsx',
  tsconfig: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'vajrajs' } },
});

async function compileAndImport(tsx: string): Promise<Record<string, unknown>> {
  const compiled = transpiler.transformSync(tsx);
  // Bun mangles the runtime identifier (e.g. `jsxDEV_7x81h0kn`). Rewrite to
  // canonical names and provide explicit imports against the local source.
  const stable = compiled
    .replace(/jsxDEV_[A-Za-z0-9]+/g, '__vajraJsxDEV')
    .replace(/jsxs_[A-Za-z0-9]+/g, '__vajraJsxs')
    .replace(/jsx_[A-Za-z0-9]+/g, '__vajraJsx')
    .replace(/Fragment_[A-Za-z0-9]+/g, '__vajraFragment');
  const runtimeUrl = new URL('../../src/ssr/jsx-runtime.ts', import.meta.url).href;
  const prelude =
    `import { jsx as __vajraJsx, jsxs as __vajraJsxs, ` +
    `jsxDEV as __vajraJsxDEV, Fragment as __vajraFragment } from "${runtimeUrl}";\n`;
  const moduleSource = prelude + stable;
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64');
  return import(dataUrl);
}

describe('JSX runtime · real Bun TSX compilation', () => {
  test('host element with single child renders content', async () => {
    const mod = await compileAndImport(
      `export const tree = <div className="card"><p>hello</p></div>;`,
    );
    const html = await renderToString(mod.tree as never);
    expect(html).toContain('<div class="card">');
    expect(html).toContain('<p>hello</p>');
  });

  test('function component with JSX children renders content (regression for v1.2.0 bug)', async () => {
    const mod = await compileAndImport(`
      function Box(props: { children?: unknown }) {
        return <div className="box">{props.children}</div>;
      }
      export const tree = <Box><p>Hello SSR</p></Box>;
    `);
    const html = await renderToString(mod.tree as never);
    expect(html).toContain('<div class="box">');
    expect(html).toContain('<p>Hello SSR</p>');
  });

  test('function component with multiple JSX children preserves order', async () => {
    const mod = await compileAndImport(`
      function List(props: { children?: unknown }) {
        return <ul>{props.children}</ul>;
      }
      export const tree = (
        <List>
          <li>first</li>
          <li>second</li>
          <li>third</li>
        </List>
      );
    `);
    const html = await renderToString(mod.tree as never);
    const firstIdx = html.indexOf('first');
    const secondIdx = html.indexOf('second');
    const thirdIdx = html.indexOf('third');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });

  test('nested function components compose correctly', async () => {
    const mod = await compileAndImport(`
      function Card(props: { title: string; children?: unknown }) {
        return <section className="card"><h2>{props.title}</h2>{props.children}</section>;
      }
      function Body(props: { children?: unknown }) {
        return <div className="body">{props.children}</div>;
      }
      export const tree = (
        <Card title="Greetings">
          <Body><p>nested content</p></Body>
        </Card>
      );
    `);
    const html = await renderToString(mod.tree as never);
    expect(html).toContain('<section class="card">');
    expect(html).toContain('<h2>Greetings</h2>');
    expect(html).toContain('<div class="body">');
    expect(html).toContain('<p>nested content</p>');
  });

  test('Fragment with JSX children renders flat output', async () => {
    const mod = await compileAndImport(`
      export const tree = <><span>a</span><span>b</span></>;
    `);
    const html = await renderToString(mod.tree as never);
    expect(html).toContain('<span>a</span>');
    expect(html).toContain('<span>b</span>');
  });
});
