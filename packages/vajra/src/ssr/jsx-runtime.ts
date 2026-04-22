/**
 * Vajra JSX Runtime
 * Lightweight, async-capable, streaming-ready.
 * No virtual DOM, no reconciler. Server-first.
 */

/* Types */
export type Child = VNode | string | number | boolean | null | undefined | Child[];
export type Props = Record<string, unknown> & { children?: Child | Child[] };
export type ComponentFn = (props: Props) => VNode | Promise<VNode>;

export interface VNode {
  type: string | ComponentFn | typeof Fragment;
  props: Props;
  children: Child[];
}

/* Fragment symbol */
export const Fragment = Symbol.for('vajra.fragment');

/**
 * JSX automatic runtime (react-jsx).
 *
 * Per the JSX automatic-runtime spec, children always live in `props.children`.
 * Args after `props` are: `key` (jsx, jsxs), or `key, isStatic, src, self`
 * (jsxDEV from Bun). They are NOT children. Aliasing all three to a single
 * implementation that ignores extra args is correct.
 *
 * For hand-written manual calls that pass children positionally (legacy code,
 * non-JSX scripts), use `createElement` instead — that's the classic-runtime
 * contract and accepts variadic children.
 */
export function jsx(
  type: string | ComponentFn | typeof Fragment,
  props: Props | null,
  _key?: unknown,
  ..._devArgs: unknown[]
): VNode {
  const safeProps = props ?? {};
  const ch = safeProps.children;
  const src: Child[] = ch == null ? [] : Array.isArray(ch) ? ch : [ch];
  const { children: _ignored, ...restProps } = safeProps;
  return { type, props: restProps, children: flattenChildren(src) };
}

export const jsxs = jsx;
export const jsxDEV = jsx;

/**
 * createElement — classic JSX runtime (jsxFactory) and manual-call entry point.
 *
 * Children arrive as variadic rest args, matching React.createElement.
 * Used when tsconfig sets `"jsx": "react", "jsxFactory": "createElement"`,
 * and recommended for any code that constructs VNodes by hand.
 */
export function createElement(
  type: string | ComponentFn | typeof Fragment,
  props: Props | null,
  ...children: Child[]
): VNode {
  const safeProps = props ?? {};
  const src: Child[] = children.length > 0
    ? children
    : safeProps.children != null
      ? Array.isArray(safeProps.children) ? safeProps.children : [safeProps.children]
      : [];
  const { children: _ignored, ...restProps } = safeProps;
  return { type, props: restProps, children: flattenChildren(src) };
}

/* Flatten nested children arrays, filter nulls */
function flattenChildren(children: Child[]): Child[] {
  const result: Child[] = [];
  for (const child of children) {
    if (child == null || typeof child === 'boolean') continue;
    if (Array.isArray(child)) {
      result.push(...flattenChildren(child));
    } else {
      result.push(child);
    }
  }
  return result;
}

/* Suspense boundary for streaming SSR */
export interface SuspenseProps {
  fallback: VNode | string;
  children: Child | Child[];
}

export function Suspense(props: SuspenseProps): VNode {
  return {
    type: '__suspense__',
    props: { fallback: props.fallback },
    children: Array.isArray(props.children) ? props.children : [props.children],
  };
}

/* Escape HTML entities */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/* Check if value is a VNode */
export function isVNode(value: unknown): value is VNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'props' in value &&
    'children' in value
  );
}

/* Self-closing HTML tags */
export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/* Convert props to HTML attributes string */
export function propsToAttributes(props: Props): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'key' || key === 'ref') continue;
    if (value == null || value === false) continue;

    if (key === 'className') {
      parts.push(`class="${escapeHtml(String(value))}"`);
    } else if (key === 'htmlFor') {
      parts.push(`for="${escapeHtml(String(value))}"`);
    } else if (key === 'style' && typeof value === 'object') {
      const css = Object.entries(value as Record<string, string | number>)
        .map(([k, v]) => `${k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}:${v}`)
        .join(';');
      parts.push(`style="${escapeHtml(css)}"`);
    } else if (key === 'dangerouslySetInnerHTML') {
      continue; // handled in renderer
    } else if (typeof value === 'boolean' && value) {
      parts.push(key);
    } else if (!key.startsWith('on')) {
      // Skip event handlers on server
      parts.push(`${key}="${escapeHtml(String(value))}"`);
    }
  }

  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}
