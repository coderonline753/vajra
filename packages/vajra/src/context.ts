/**
 * Vajra Context
 * Per-request context object. Type-safe, fast, minimal allocations.
 */

import { parseCookies, serializeCookie, type CookieOptions } from './cookie';

/** Keys that could pollute Object.prototype */
const POISONED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Deep sanitize parsed body to prevent prototype pollution */
function sanitizeObject(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  const clean: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (POISONED_KEYS.has(key)) continue;
    clean[key] = typeof value === 'object' && value !== null ? sanitizeObject(value) : value;
  }
  return clean;
}

export { HttpError, VajraError, PayloadTooLargeError } from './errors';
import { HttpError, VajraError, PayloadTooLargeError } from './errors';

export class Context {
  readonly req: Request;
  readonly url: URL;
  private _params: Record<string, string>;
  private _query: Record<string, string> | null = null;
  private _body: unknown = undefined;
  private _bodyParsed = false;
  private store: Map<string, unknown> = new Map();
  private _status = 200;
  private _headers: Headers = new Headers();
  private _maxBodySize: number;
  private _cookies: Record<string, string> | null = null;
  private _setCookies: string[] = [];

  constructor(req: Request, params: Record<string, string> = {}, url?: URL, maxBodySize = 1_048_576) {
    this.req = req;
    this.url = url ?? new URL(req.url);
    this._params = params;
    this._maxBodySize = maxBodySize;
  }

  /** Get route parameter */
  param(name: string): string {
    return this._params[name] || '';
  }

  /** Get all route parameters */
  get params(): Record<string, string> {
    return this._params;
  }

  /** Get query parameter */
  query(name: string): string | null {
    return this.url.searchParams.get(name);
  }

  /** Get all query parameters as object (last value wins for duplicate keys) */
  get queries(): Record<string, string> {
    if (!this._query) {
      this._query = {};
      this.url.searchParams.forEach((v, k) => { this._query![k] = v; });
    }
    return this._query;
  }

  /** Get all values for a query parameter */
  queryAll(name: string): string[] {
    return this.url.searchParams.getAll(name);
  }

  /** Get all query parameters with multi-value support */
  get queriesAll(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    this.url.searchParams.forEach((v, k) => {
      if (!result[k]) result[k] = [];
      result[k].push(v);
    });
    return result;
  }

  /** Get request header */
  header(name: string): string | null {
    return this.req.headers.get(name);
  }

  /** Get request method */
  get method(): string {
    return this.req.method;
  }

  /** Get request path */
  get path(): string {
    return this.url.pathname;
  }

  /** Parse and get request body (prototype pollution safe) */
  async body<T = unknown>(): Promise<T> {
    if (!this._bodyParsed) {
      const contentLength = parseInt(this.req.headers.get('content-length') || '0', 10);
      if (contentLength > this._maxBodySize) {
        this._bodyParsed = true;
        throw new PayloadTooLargeError(this._maxBodySize);
      }

      const ct = this.req.headers.get('content-type') || '';
      try {
        if (ct.includes('application/json')) {
          this._body = sanitizeObject(await this.req.json());
        } else if (ct.includes('application/x-www-form-urlencoded')) {
          const text = await this.req.text();
          this._body = sanitizeObject(Object.fromEntries(new URLSearchParams(text)));
        } else if (ct.includes('multipart/form-data')) {
          const formData = await this.req.formData();
          const obj: Record<string, unknown> = Object.create(null);
          formData.forEach((value, key) => {
            if (!POISONED_KEYS.has(key)) obj[key] = value;
          });
          this._body = obj;
        } else {
          this._body = await this.req.text();
        }
      } catch (err) {
        this._bodyParsed = true;
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, 'Bad Request: Invalid body');
      }
      this._bodyParsed = true;
    }
    return this._body as T;
  }

  /** Store data for middleware sharing */
  set<V = unknown>(key: string, value: V): void {
    this.store.set(key, value);
  }

  /** Retrieve middleware data */
  get<V = unknown>(key: string): V | undefined {
    return this.store.get(key) as V | undefined;
  }

  /** Set response status */
  status(code: number): this {
    this._status = code;
    return this;
  }

  /** Set response header */
  setHeader(name: string, value: string): this {
    this._headers.set(name, value);
    return this;
  }

  /** Get a cookie value by name */
  cookie(name: string): string | undefined {
    if (!this._cookies) {
      this._cookies = parseCookies(this.req.headers.get('cookie') || '');
    }
    return this._cookies[name];
  }

  /** Get all cookies */
  get cookies(): Record<string, string> {
    if (!this._cookies) {
      this._cookies = parseCookies(this.req.headers.get('cookie') || '');
    }
    return this._cookies;
  }

  /** Set a response cookie */
  setCookie(name: string, value: string, options?: CookieOptions): this {
    this._setCookies.push(serializeCookie(name, value, options));
    return this;
  }

  /** Delete a cookie */
  deleteCookie(name: string, options?: Pick<CookieOptions, 'path' | 'domain'>): this {
    this._setCookies.push(serializeCookie(name, '', { ...options, maxAge: 0 }));
    return this;
  }

  /** Clone headers for each response to prevent cross-response pollution */
  private cloneHeaders(): Headers {
    const headers = new Headers(this._headers);
    for (const cookie of this._setCookies) {
      headers.append('set-cookie', cookie);
    }
    return headers;
  }

  /** JSON response */
  json<T>(data: T, status?: number): Response {
    const s = status ?? this._status;
    const headers = this.cloneHeaders();
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(data), { status: s, headers });
  }

  /** Text response */
  text(data: string, status?: number): Response {
    const s = status ?? this._status;
    const headers = this.cloneHeaders();
    headers.set('content-type', 'text/plain; charset=utf-8');
    return new Response(data, { status: s, headers });
  }

  /** HTML response */
  html(data: string, status?: number): Response {
    const s = status ?? this._status;
    const headers = this.cloneHeaders();
    headers.set('content-type', 'text/html; charset=utf-8');
    return new Response(data, { status: s, headers });
  }

  /** Redirect response */
  redirect(url: string, status: 301 | 302 | 307 | 308 = 302): Response {
    const headers = this.cloneHeaders();
    headers.set('location', url);
    return new Response(null, { status, headers });
  }

  /** Stream response (SSE or chunked) */
  stream(readable: ReadableStream, contentType = 'text/event-stream'): Response {
    const headers = this.cloneHeaders();
    headers.set('content-type', contentType);
    headers.set('cache-control', 'no-cache');
    headers.set('connection', 'keep-alive');
    return new Response(readable, { status: this._status, headers });
  }

  /** Empty response with status */
  empty(status = 204): Response {
    return new Response(null, { status, headers: this.cloneHeaders() });
  }

  /** SSE helper: create a streaming response for Server-Sent Events */
  sse(callback: (ctx: {
    send: (event: string, data: string, id?: string) => void;
    close: () => void;
    signal: AbortSignal;
    lastEventId: string | null;
  }) => void | Promise<void>): Response {
    const lastEventId = this.req.headers.get('last-event-id');
    const abortController = new AbortController();

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: string, id?: string) => {
          let msg = '';
          if (id) msg += `id: ${id}\n`;
          msg += `event: ${event}\n`;
          // Handle multi-line data
          for (const line of data.split('\n')) {
            msg += `data: ${line}\n`;
          }
          msg += '\n';
          controller.enqueue(encoder.encode(msg));
        };
        const close = () => {
          controller.close();
          abortController.abort();
        };
        try {
          // Send retry directive (5 seconds reconnect)
          controller.enqueue(encoder.encode('retry: 5000\n\n'));
          await callback({ send, close, signal: abortController.signal, lastEventId });
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        abortController.abort();
      },
    });
    return this.stream(stream);
  }
}
