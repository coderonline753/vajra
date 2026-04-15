import { describe, test, expect } from 'bun:test';
import {
  jsx, Fragment, Suspense, escapeHtml, propsToAttributes, isVNode, VOID_ELEMENTS,
} from '../../src/ssr/jsx-runtime';

describe('JSX Runtime', () => {
  test('creates VNode for HTML element', () => {
    const node = jsx('div', { className: 'test' }, 'Hello');
    expect(node.type).toBe('div');
    expect(node.props.className).toBe('test');
    expect(node.children).toEqual(['Hello']);
  });

  test('creates VNode for component function', () => {
    const MyComponent = (props: any) => jsx('span', {}, props.name);
    const node = jsx(MyComponent, { name: 'Vajra' });
    expect(typeof node.type).toBe('function');
    expect(node.props.name).toBe('Vajra');
  });

  test('creates Fragment VNode', () => {
    const node = jsx(Fragment, {}, 'A', 'B');
    expect(node.type).toBe(Fragment);
    expect(node.children).toEqual(['A', 'B']);
  });

  test('flattens nested children', () => {
    const node = jsx('div', {}, ['A', ['B', 'C']], 'D');
    expect(node.children).toEqual(['A', 'B', 'C', 'D']);
  });

  test('filters null, undefined, boolean children', () => {
    const node = jsx('div', {}, 'A', null, undefined, false, true, 'B');
    expect(node.children).toEqual(['A', 'B']);
  });

  test('handles children from props', () => {
    const node = jsx('div', { children: 'Hello' });
    expect(node.children).toEqual(['Hello']);
  });

  test('creates Suspense node', () => {
    const fallback = jsx('span', {}, 'Loading...');
    const node = Suspense({ fallback, children: jsx('div', {}, 'Content') });
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
