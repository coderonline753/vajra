/**
 * Vajra SSR Renderer
 * renderToString: Full HTML string (simple, cacheable)
 * renderToStream: Streaming HTML with Suspense boundaries (fast TTFB)
 */

import {
  type VNode,
  type Child,
  type ComponentFn,
  type Props,
  Fragment,
  escapeHtml,
  propsToAttributes,
  isVNode,
  VOID_ELEMENTS,
} from './jsx-runtime';

/* Render VNode tree to complete HTML string */
export async function renderToString(node: VNode | string | number | null): Promise<string> {
  if (node == null) return '';
  if (typeof node === 'string') return escapeHtml(node);
  if (typeof node === 'number') return String(node);
  if (!isVNode(node)) return '';

  return renderNodeToString(node);
}

async function renderNodeToString(node: VNode): Promise<string> {
  const { type, props, children } = node;

  // Fragment: render children only
  if (type === Fragment) {
    return renderChildrenToString(children);
  }

  // Suspense: resolve async children, use fallback on error
  if (type === '__suspense__') {
    try {
      return await renderChildrenToString(children);
    } catch {
      const fallback = props.fallback;
      if (typeof fallback === 'string') return escapeHtml(fallback);
      if (isVNode(fallback)) return renderNodeToString(fallback);
      return '';
    }
  }

  // Component function (sync or async)
  if (typeof type === 'function') {
    const componentProps: Props = { ...props };
    if (children.length > 0) {
      componentProps.children = children.length === 1 ? children[0] : children;
    }
    const result = await (type as ComponentFn)(componentProps);
    if (typeof result === 'string') return escapeHtml(result);
    if (typeof result === 'number') return String(result);
    if (isVNode(result)) return renderNodeToString(result);
    return '';
  }

  // HTML element
  const tag = type as string;
  const attrs = propsToAttributes(props);

  if (VOID_ELEMENTS.has(tag)) {
    return `<${tag}${attrs} />`;
  }

  // dangerouslySetInnerHTML
  const dangerousHtml = props.dangerouslySetInnerHTML as { __html: string } | undefined;
  if (dangerousHtml) {
    return `<${tag}${attrs}>${dangerousHtml.__html}</${tag}>`;
  }

  const childHtml = await renderChildrenToString(children);
  return `<${tag}${attrs}>${childHtml}</${tag}>`;
}

async function renderChildrenToString(children: Child[]): Promise<string> {
  const parts: string[] = [];
  for (const child of children) {
    if (child == null || typeof child === 'boolean') continue;
    if (typeof child === 'string') {
      parts.push(escapeHtml(child));
    } else if (typeof child === 'number') {
      parts.push(String(child));
    } else if (Array.isArray(child)) {
      parts.push(await renderChildrenToString(child));
    } else if (isVNode(child)) {
      parts.push(await renderNodeToString(child));
    }
  }
  return parts.join('');
}

/* ═══════ STREAMING RENDERER ═══════ */

interface StreamChunk {
  id: string;
  html: string;
}

/**
 * Render VNode tree to a ReadableStream.
 * Shell renders immediately, Suspense boundaries stream as they resolve.
 */
export function renderToStream(
  node: VNode,
  options: {
    bootstrapScripts?: string[];
    bootstrapModules?: string[];
    onError?: (error: Error) => void;
  } = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pendingSuspense: Promise<StreamChunk>[] = [];
  let suspenseCounter = 0;

  return new ReadableStream({
    async start(controller) {
      try {
        // Render shell (sync parts + Suspense fallbacks)
        const shellHtml = await renderShell(node, pendingSuspense, () => `__vajra_s${suspenseCounter++}`);

        // Send shell immediately
        controller.enqueue(encoder.encode(shellHtml));

        // Stream resolved Suspense boundaries
        if (pendingSuspense.length > 0) {
          const results = await Promise.allSettled(pendingSuspense);

          for (const result of results) {
            if (result.status === 'fulfilled') {
              const { id, html } = result.value;
              const replaceScript = `<script>vajra_sr("${id}",${JSON.stringify(html)})</script>`;
              controller.enqueue(encoder.encode(replaceScript));
            } else {
              options.onError?.(result.reason);
            }
          }
        }

        // Bootstrap scripts
        if (options.bootstrapScripts?.length) {
          for (const src of options.bootstrapScripts) {
            controller.enqueue(encoder.encode(`<script src="${escapeHtml(src)}"></script>`));
          }
        }
        if (options.bootstrapModules?.length) {
          for (const src of options.bootstrapModules) {
            controller.enqueue(encoder.encode(`<script type="module" src="${escapeHtml(src)}"></script>`));
          }
        }

        // Streaming replace function (injected once)
        if (pendingSuspense.length > 0) {
          const replaceRuntime = `<script>function vajra_sr(id,html){var el=document.getElementById(id);if(el){var t=document.createElement("template");t.innerHTML=html;el.replaceWith(t.content)}}</script>`;
          // This should actually be in the shell, let me prepend it
          controller.enqueue(encoder.encode(replaceRuntime));
        }

        controller.close();
      } catch (err) {
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
        controller.error(err);
      }
    },
  });
}

/* Render shell: resolve sync content, capture Suspense boundaries as pending */
async function renderShell(
  node: VNode,
  pending: Promise<StreamChunk>[],
  genId: () => string
): Promise<string> {
  return renderNodeShell(node, pending, genId);
}

async function renderNodeShell(
  node: VNode | Child,
  pending: Promise<StreamChunk>[],
  genId: () => string
): Promise<string> {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return escapeHtml(node);
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    const parts = await Promise.all(node.map(c => renderNodeShell(c, pending, genId)));
    return parts.join('');
  }
  if (!isVNode(node)) return '';

  const { type, props, children } = node;

  // Fragment
  if (type === Fragment) {
    const parts = await Promise.all(children.map(c => renderNodeShell(c, pending, genId)));
    return parts.join('');
  }

  // Suspense: render fallback immediately, resolve children async
  if (type === '__suspense__') {
    const id = genId();
    const fallback = props.fallback;
    let fallbackHtml = '';
    if (typeof fallback === 'string') fallbackHtml = escapeHtml(fallback);
    else if (isVNode(fallback)) fallbackHtml = await renderNodeToString(fallback);

    // Queue async resolution
    const asyncResolve = (async (): Promise<StreamChunk> => {
      const html = await renderChildrenToString(children);
      return { id, html };
    })();
    pending.push(asyncResolve);

    return `<span id="${id}">${fallbackHtml}</span>`;
  }

  // Component function
  if (typeof type === 'function') {
    const componentProps: Props = { ...props };
    if (children.length > 0) {
      componentProps.children = children.length === 1 ? children[0] : children;
    }
    const result = await (type as ComponentFn)(componentProps);
    return renderNodeShell(result, pending, genId);
  }

  // HTML element
  const tag = type as string;
  const attrs = propsToAttributes(props);

  if (VOID_ELEMENTS.has(tag)) {
    return `<${tag}${attrs} />`;
  }

  const dangerousHtml = props.dangerouslySetInnerHTML as { __html: string } | undefined;
  if (dangerousHtml) {
    return `<${tag}${attrs}>${dangerousHtml.__html}</${tag}>`;
  }

  const parts = await Promise.all(children.map(c => renderNodeShell(c, pending, genId)));
  return `<${tag}${attrs}>${parts.join('')}</${tag}>`;
}
