import { describe, test, expect } from 'bun:test';
import {
  jsx, jsxs, jsxDEV, createElement, Fragment, Suspense,
  escapeHtml, propsToAttributes, isVNode, VOID_ELEMENTS,
} from '../../src/ssr/jsx-runtime';

describe('JSX automatic runtime (jsx / jsxs / jsxDEV)', () => {
  test('jsx reads children from props.children', () => {
    const node = jsx('div', { className: 'test', children: 'Hello' });
    expect(node.type).toBe('div');
    expect(node.props.className).toBe('test');
    expect(node.children).toEqual(['Hello']);
  });

  test('jsx ignores positional 3rd arg (key) — spec compliant', () => {
    const node = jsx('div', { children: 'real' }, 'some-key');
    expect(node.children).toEqual(['real']);
  });

  test('jsxs handles array children from props', () => {
    const node = jsxs('ul', { children: [jsx('li', { children: 'A' }), jsx('li', { children: 'B' })] });
    expect(node.children.length).toBe(2);
  });

  test('jsxDEV ignores Bun dev signature extras (key, isStatic, src, self)', () => {
    // Simulates Bun's dev-mode call: jsxDEV(type, props, key, isStatic, src, self)
    const node = jsxDEV(
      'p',
      { children: 'real content' },
      undefined, // key
      false,     // isStatic
      undefined, // src
      {},        // self
    );
    expect(node.children).toEqual(['real content']);
  });

  test('jsxDEV with function component preserves nested JSX children', () => {
    // Reproduces the v1.2.0 bug: function component with JSX children rendered empty
    const Box = (props: any) => jsx('div', { children: props.children });
    const inner = jsx('p', { children: 'Hello' });
    const node = jsxDEV(Box, { children: inner }, undefined, false, undefined, {});
    expect(typeof node.type).toBe('function');
    expect(node.children).toEqual([inner]);
  });

  test('jsx component without children gives empty children list', () => {
    const node = jsx('div', { className: 'empty' });
    expect(node.children).toEqual([]);
  });
});

describe('JSX classic runtime (createElement)', () => {
  test('creates VNode for HTML element with rest-args children', () => {
    const node = createElement('div', { className: 'test' }, 'Hello');
    expect(node.type).toBe('div');
    expect(node.props.className).toBe('test');
    expect(node.children).toEqual(['Hello']);
  });

  test('creates VNode for component function', () => {
    const MyComponent = (props: any) => createElement('span', {}, props.name);
    const node = createElement(MyComponent, { name: 'Vajra' });
    expect(typeof node.type).toBe('function');
    expect(node.props.name).toBe('Vajra');
  });

  test('creates Fragment VNode with multiple positional children', () => {
    const node = createElement(Fragment, {}, 'A', 'B');
    expect(node.type).toBe(Fragment);
    expect(node.children).toEqual(['A', 'B']);
  });

  test('flattens nested children', () => {
    const node = createElement('div', {}, ['A', ['B', 'C']], 'D');
    expect(node.children).toEqual(['A', 'B', 'C', 'D']);
  });

  test('filters null, undefined, boolean children', () => {
    const node = createElement('div', {}, 'A', null, undefined, false, true, 'B');
    expect(node.children).toEqual(['A', 'B']);
  });

  test('falls back to props.children when rest args empty', () => {
    const node = createElement('div', { children: 'Hello' });
    expect(node.children).toEqual(['Hello']);
  });

  test('null props is treated as empty', () => {
    const node = createElement('div', null, 'Hello');
    expect(node.children).toEqual(['Hello']);
    expect(node.props).toEqual({});
  });

  test('creates Suspense node', () => {
    const fallback = createElement('span', {}, 'Loading...');
    const node = Suspense({ fallback, children: createElement('div', {}, 'Content') });
    expect(node.type).toBe('__suspense__');
    expect(node.props.fallback).toBe(fallback);
  });
});

describe('escapeHtml', () => {
  test('escapes HTML entities', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  test('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  test('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe("it&#x27;s");
  });
});

describe('propsToAttributes', () => {
  test('converts className to class', () => {
    expect(propsToAttributes({ className: 'btn' })).toBe(' class="btn"');
  });

  test('converts htmlFor to for', () => {
    expect(propsToAttributes({ htmlFor: 'email' })).toBe(' for="email"');
  });

  test('converts style object to CSS string', () => {
    const result = propsToAttributes({ style: { backgroundColor: 'red', fontSize: '14px' } });
    expect(result).toContain('background-color:red');
    expect(result).toContain('font-size:14px');
  });

  test('skips null, undefined, false props', () => {
    expect(propsToAttributes({ hidden: false, disabled: null, 'data-x': undefined })).toBe('');
  });

  test('renders boolean true as attribute name only', () => {
    expect(propsToAttributes({ disabled: true })).toBe(' disabled');
  });

  test('skips event handlers (on*)', () => {
    expect(propsToAttributes({ onClick: () => {} })).toBe('');
  });

  test('skips children, key, ref', () => {
    expect(propsToAttributes({ children: 'x', key: '1', ref: {} })).toBe('');
  });
});

describe('isVNode', () => {
  test('detects VNode', () => {
    expect(isVNode(jsx('div', {}))).toBe(true);
  });

  test('rejects string', () => {
    expect(isVNode('hello')).toBe(false);
  });

  test('rejects null', () => {
    expect(isVNode(null)).toBe(false);
  });
});

describe('VOID_ELEMENTS', () => {
  test('includes common void elements', () => {
    expect(VOID_ELEMENTS.has('br')).toBe(true);
    expect(VOID_ELEMENTS.has('img')).toBe(true);
    expect(VOID_ELEMENTS.has('input')).toBe(true);
    expect(VOID_ELEMENTS.has('meta')).toBe(true);
    expect(VOID_ELEMENTS.has('link')).toBe(true);
  });

  test('excludes non-void elements', () => {
    expect(VOID_ELEMENTS.has('div')).toBe(false);
    expect(VOID_ELEMENTS.has('span')).toBe(false);
  });
});
