/**
 * Vajra SSR Route
 * defineRoute() — Remix-inspired loader/action/render pattern.
 * Type-safe: loader data flows into render with full inference.
 */

import type { Context } from '../context';
import type { VNode } from './jsx-runtime';
import { renderToString, renderToStream } from './renderer';
import { renderHead, type HeadData } from './head';
import { getIslandPreloads } from './island';

/* Route context passed to load/action/render */
export interface RouteContext {
  request: Request;
  params: Record<string, string>;
  query: Record<string, string>;
  url: URL;
  cookie: (name: string) => string | undefined;
  /** Throw to return 404 */
  notFound: () => never;
  /** Return redirect response */
  redirect: (url: string, status?: 301 | 302 | 307 | 308) => never;
}

/* Cache configuration for the route */
export interface RouteCacheConfig {
  /** Cache strategy */
  type: 'no-cache' | 'static' | 'swr' | 'isr';
  /** Max age in seconds */
  maxAge?: number;
  /** Stale-while-revalidate window in seconds */
  staleWhileRevalidate?: number;
  /** Cache vary keys (e.g. ['cookie:locale', 'header:accept-language']) */
  varyBy?: string[];
  /** Tags for targeted invalidation */
  tags?: string[];
}

/* Route definition */
export interface RouteDefinition<T = unknown> {
  /** Load data on the server. Runs before render. */
  load?: (ctx: RouteContext) => T | Promise<T>;

  /** Handle mutations (POST, PUT, DELETE). */
  action?: (ctx: RouteContext) => unknown | Promise<unknown>;

  /** Generate head/meta tags from loaded data. Resolved before streaming. */
  meta?: (data: { data: T; params: Record<string, string> }) => HeadData;

  /** Render the page. Receives loaded data. */
  render: (props: { data: T; params: Record<string, string>; url: URL }) => VNode | Promise<VNode>;

  /** Cache configuration */
  cache?: RouteCacheConfig;

  /** Enable streaming SSR (default: true) */
  streaming?: boolean;

  /** Error render */
  errorRender?: (props: { error: Error; params: Record<string, string> }) => VNode | Promise<VNode>;
}

/* Internal error types */
class NotFoundError extends Error {
  constructor() { super('Not Found'); this.name = 'NotFoundError'; }
}

class RedirectError extends Error {
  url: string;
  status: number;
  constructor(url: string, status: number) {
    super(`Redirect to ${url}`);
    this.name = 'RedirectError';
    this.url = url;
    this.status = status;
  }
}

/**
 * Define a server-rendered route with typed data flow.
 *
 * @example
 * const productPage = defineRoute({
 *   async load({ params }) {
 *     const product = await db.products.findById(params.id)
 *     if (!product) throw ctx.notFound()
 *     return { product }
 *   },
 *   meta({ data }) {
 *     return { title: data.product.name, description: data.product.description }
 *   },
 *   render({ data }) {
 *     return <ProductPage product={data.product} />
 *   }
 * })
 */
export function defineRoute<T>(definition: RouteDefinition<T>) {
  const { load, action, meta, render, cache, streaming = true, errorRender } = definition;

  return {
    definition,

    /** Handle the route — called by Vajra router integration */
    async handle(c: Context): Promise<Response> {
      const url = c.url;
      const params = c.params;
      const query = c.queries;
      const request = c.req;

      // Build route context
      const ctx: RouteContext = {
        request,
        params,
        query,
        url,
        cookie: (name: string) => c.cookie(name),
        notFound: () => { throw new NotFoundError(); },
        redirect: (redirectUrl: string, status = 302) => { throw new RedirectError(redirectUrl, status); },
      };

      try {
        // Handle action (POST/PUT/DELETE)
        if (action && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(c.method)) {
          const actionResult = await action(ctx);
          if (actionResult instanceof Response) return actionResult;
          // After action, fall through to render (PRG pattern handled via redirect in action)
        }

        // Load data
        let data: T = undefined as T;
        if (load) {
          data = await load(ctx);
        }

        // Generate head tags (BEFORE streaming starts)
        let headHtml = '';
        if (meta) {
          const headData = meta({ data, params });
          headHtml = renderHead(headData);
        }

        // Island preloads
        const preloads = getIslandPreloads();

        // Render
        const vnode = await render({ data, params, url });

        if (streaming) {
          // Streaming: wrap in HTML shell with head
          const shellVNode = wrapInHtmlShell(vnode, headHtml, preloads);
          const doctype = new TextEncoder().encode('<!DOCTYPE html>');
          const ssrStream = renderToStream(shellVNode, {
            onError: (err) => console.error('[Vajra SSR]', err.message),
          });

          // Prepend doctype to stream
          const stream = new ReadableStream({
            async start(controller) {
              controller.enqueue(doctype);
              const reader = ssrStream.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
              controller.close();
            },
          });

          const headers = new Headers({
            'content-type': 'text/html; charset=utf-8',
            'transfer-encoding': 'chunked',
          });

          // Cache headers
          if (cache) {
            headers.set('cache-control', buildCacheControl(cache));
          }

          return new Response(stream, { status: 200, headers });
        } else {
          // Full render
          const shellVNode = wrapInHtmlShell(vnode, headHtml, preloads);
          const html = '<!DOCTYPE html>' + await renderToString(shellVNode);

          const headers = new Headers({
            'content-type': 'text/html; charset=utf-8',
          });

          if (cache) {
            headers.set('cache-control', buildCacheControl(cache));
          }

          return new Response(html, { status: 200, headers });
        }
      } catch (err) {
        if (err instanceof NotFoundError) {
          if (errorRender) {
            const vnode = await errorRender({ error: err, params });
            const html = await renderToString(vnode);
            return new Response(html, {
              status: 404,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          return c.html('<h1>404 Not Found</h1>', 404);
        }

        if (err instanceof RedirectError) {
          return c.redirect(err.url, err.status as 301 | 302 | 307 | 308);
        }

        console.error('[Vajra SSR] Route error:', err);

        if (errorRender) {
          const vnode = await errorRender({ error: err instanceof Error ? err : new Error(String(err)), params });
          const html = await renderToString(vnode);
          return new Response(html, {
            status: 500,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }

        return c.html('<h1>500 Internal Server Error</h1>', 500);
      }
    },
  };
}

/* Wrap content VNode in full HTML document shell */
function wrapInHtmlShell(content: VNode, headHtml: string, preloads: string): VNode {
  return {
    type: 'html',
    props: { lang: 'en' },
    children: [
      {
        type: 'head',
        props: {
          dangerouslySetInnerHTML: {
            __html: `<meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    ${headHtml}${preloads ? '\n    ' + preloads : ''}`,
          },
        },
        children: [],
      },
      {
        type: 'body',
        props: {},
        children: [content],
      },
    ],
  };
}

/* Build Cache-Control header from config */
function buildCacheControl(cache: RouteCacheConfig): string {
  switch (cache.type) {
    case 'no-cache':
      return 'no-cache, no-store, must-revalidate';
    case 'static':
      return `public, max-age=${cache.maxAge || 3600}, immutable`;
    case 'swr':
      return `public, max-age=${cache.maxAge || 60}, stale-while-revalidate=${cache.staleWhileRevalidate || 300}`;
    case 'isr':
      return `public, max-age=${cache.maxAge || 60}, stale-while-revalidate=${cache.staleWhileRevalidate || 31536000}`;
    default:
      return 'no-cache';
  }
}
