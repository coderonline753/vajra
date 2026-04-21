/**
 * Vajra Contract Module
 * Shared REST route contracts with Zod validation → end-to-end type-safe client.
 * Single source of truth for both server and client.
 *
 * const contract = defineContract({
 *   createUser: {
 *     method: 'POST',
 *     path: '/users',
 *     body: z.object({ name: z.string(), email: z.string().email() }),
 *     response: z.object({ id: z.string(), createdAt: z.date() }),
 *   },
 * });
 *
 * // Server
 * app.contract(contract, {
 *   createUser: async ({ body }) => ({ id: '1', createdAt: new Date() }),
 * });
 *
 * // Client (typed)
 * const client = createClient(contract, { baseUrl: 'https://api.x.com' });
 * const user = await client.createUser({ body: { name: 'X', email: 'x@y.z' } });
 */

import type { ZodTypeAny, infer as zInfer } from 'zod';
import type { Context } from './context';
import type { Handler, Middleware } from './middleware';
import { fastParse } from './native-bridge';

/* ═════════════ TYPES ═════════════ */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteDef<
  B extends ZodTypeAny | undefined = undefined,
  Q extends ZodTypeAny | undefined = undefined,
  P extends ZodTypeAny | undefined = undefined,
  R extends ZodTypeAny | undefined = undefined,
> {
  method: HttpMethod;
  path: string;
  body?: B;
  query?: Q;
  params?: P;
  response?: R;
  headers?: Record<string, string>;
  /** Optional summary for OpenAPI gen */
  summary?: string;
  /** Tags for OpenAPI */
  tags?: string[];
}

export type Contract = Record<string, RouteDef>;

type InputOf<D extends RouteDef> =
  (D['body'] extends ZodTypeAny ? { body: zInfer<D['body']> } : {}) &
  (D['query'] extends ZodTypeAny ? { query: zInfer<D['query']> } : {}) &
  (D['params'] extends ZodTypeAny ? { params: zInfer<D['params']> } : {});

type OutputOf<D extends RouteDef> =
  D['response'] extends ZodTypeAny ? zInfer<D['response']> : unknown;

type InputArg<D extends RouteDef> =
  keyof InputOf<D> extends never ? (void | undefined) : InputOf<D>;

/* ═════════════ DEFINE CONTRACT ═════════════ */

export function defineContract<C extends Contract>(contract: C): C {
  return contract;
}

/* ═════════════ CLIENT ═════════════ */

export interface ClientOptions {
  /** Base URL prefix (no trailing slash) */
  baseUrl: string;
  /** Common headers sent with every request */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Custom fetch implementation (default: global fetch) */
  fetch?: typeof fetch;
  /** Pre-request hook (can mutate RequestInit) */
  beforeRequest?: (req: Request) => Request | Promise<Request>;
  /** Post-response hook (can inspect/transform) */
  afterResponse?: (res: Response) => Response | Promise<Response>;
  /**
   * Disable Zod response validation on the client. Silent type corruption
   * is possible when this is on — the promise still resolves to the declared
   * type but the payload may not match.
   *
   * Named `unsafe*` to make the risk visible at call sites. Prefer leaving
   * validation on and handling any mismatch via `afterResponse` instead.
   *
   * @default false
   */
  unsafeSkipValidation?: boolean;
  /**
   * @deprecated Renamed to `unsafeSkipValidation`. Kept for one release so
   * existing code keeps working; will be removed in v1.1. Every call with
   * this flag emits a console.warn describing how to migrate.
   */
  skipValidation?: boolean;
}

export type Client<C extends Contract> = {
  [K in keyof C]: (input: InputArg<C[K]>) => Promise<OutputOf<C[K]>>;
};

export function createClient<C extends Contract>(contract: C, options: ClientOptions): Client<C> {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  if (options.skipValidation !== undefined) {
    console.warn(
      '[Vajra Contract] `skipValidation` is deprecated and will be removed in v1.1. ' +
      'Rename to `unsafeSkipValidation` to make the risk visible at call sites.',
    );
  }
  const skipValidation = options.unsafeSkipValidation ?? options.skipValidation ?? false;

  const client: Record<string, (input: unknown) => Promise<unknown>> = {};

  for (const [name, def] of Object.entries(contract)) {
    client[name] = async (input: unknown) => {
      const filledInput = (input ?? {}) as { body?: unknown; query?: unknown; params?: unknown };
      let path = def.path;
      if (def.params && filledInput.params) {
        path = substituteParams(path, filledInput.params as Record<string, unknown>);
      }
      let url = base + path;
      if (def.query && filledInput.query) {
        const queryParsed = fastParse(def.query, filledInput.query);
        const qs = objectToQuery(queryParsed as Record<string, unknown>);
        if (qs) url += `?${qs}`;
      }

      const headers: Record<string, string> = { accept: 'application/json' };
      if (typeof options.headers === 'function') {
        Object.assign(headers, await options.headers());
      } else if (options.headers) {
        Object.assign(headers, options.headers);
      }
      if (def.headers) Object.assign(headers, def.headers);

      let body: BodyInit | undefined;
      if (def.body && filledInput.body !== undefined) {
        const parsed = fastParse(def.body, filledInput.body);
        body = JSON.stringify(parsed);
        headers['content-type'] = 'application/json';
      }

      let req = new Request(url, { method: def.method, headers, body });
      if (options.beforeRequest) req = await options.beforeRequest(req);

      let res = await fetchImpl(req);
      if (options.afterResponse) res = await options.afterResponse(res);

      if (!res.ok) {
        const text = await res.text();
        throw new ClientError(res.status, text || res.statusText, res);
      }

      const contentType = res.headers.get('content-type') ?? '';
      let data: unknown = null;
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else if (res.status !== 204) {
        data = await res.text();
      }

      if (def.response && !skipValidation && data !== null) {
        data = fastParse(def.response, data);
      }

      return data;
    };
  }

  return client as Client<C>;
}

export class ClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly response: Response,
  ) {
    super(message);
    this.name = 'ClientError';
  }
}

/* ═════════════ SERVER BINDING ═════════════ */

export type ContractHandler<D extends RouteDef> = (
  input: InputOf<D> & { ctx: Context },
) => Promise<OutputOf<D>> | OutputOf<D>;

export type ContractHandlers<C extends Contract> = {
  [K in keyof C]: ContractHandler<C[K]>;
};

export interface ContractServerHook {
  /** Register a handler — called once per route by contractRouter() */
  (method: HttpMethod, path: string, handler: Handler, middleware?: Middleware[]): void;
}

/** Produce Vajra route handlers for a contract. Pairs with an app register function. */
export function contractRouter<C extends Contract>(
  contract: C,
  handlers: ContractHandlers<C>,
): Array<{ method: HttpMethod; path: string; handler: Handler }> {
  const out: Array<{ method: HttpMethod; path: string; handler: Handler }> = [];

  for (const [name, def] of Object.entries(contract)) {
    const userHandler = (handlers as Record<string, (input: unknown) => unknown>)[name];
    if (!userHandler) continue;

    const handler: Handler = async (ctx: Context) => {
      const input: Record<string, unknown> = { ctx };

      if (def.params) {
        input.params = fastParse(def.params, ctx.params);
      }
      if (def.query) {
        input.query = fastParse(def.query, ctx.queries);
      }
      if (def.body) {
        const rawBody = await ctx.body();
        input.body = fastParse(def.body, rawBody);
      }

      const result = await userHandler(input);

      if (def.response) {
        // Validate server output too (defensive)
        const validated = fastParse(def.response, result);
        return ctx.json(validated);
      }
      return ctx.json(result);
    };

    out.push({ method: def.method, path: def.path, handler });
  }

  return out;
}

/* ═════════════ HELPERS ═════════════ */

function substituteParams(path: string, params: Record<string, unknown>): string {
  return path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new Error(`Missing route param: ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

function objectToQuery(obj: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) params.append(k, String(item));
    } else {
      params.append(k, String(v));
    }
  }
  return params.toString();
}
