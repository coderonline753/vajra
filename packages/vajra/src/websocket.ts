/**
 * Vajra WebSocket Support
 * Leverages Bun's native WebSocket server.
 * Includes upgrade hook for auth during handshake.
 */

import type { ServerWebSocket } from 'bun';

export interface WebSocketData {
  path: string;
  params: Record<string, string>;
  [key: string]: unknown;
}

export interface WebSocketHandler {
  /** Auth/validate during HTTP upgrade. Return data to merge into ws.data, or null to reject (403). */
  upgrade?: (req: Request, url: URL) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  open?: (ws: ServerWebSocket<WebSocketData>) => void;
  message?: (ws: ServerWebSocket<WebSocketData>, message: string | Buffer) => void;
  close?: (ws: ServerWebSocket<WebSocketData>, code: number, reason: string) => void;
  drain?: (ws: ServerWebSocket<WebSocketData>) => void;
  maxPayloadLength?: number;
  idleTimeout?: number;
  backpressureLimit?: number;
}

export interface WebSocketRoute {
  path: string;
  handler: WebSocketHandler;
}

export class WebSocketRouter {
  private routes: WebSocketRoute[] = [];

  add(path: string, handler: WebSocketHandler): void {
    this.routes.push({ path, handler });
  }

  match(path: string): WebSocketRoute | null {
    for (const route of this.routes) {
      if (route.path === path) return route;
      // Simple param matching: /chat/:room matches /chat/general
      if (route.path.includes(':')) {
        const routeParts = route.path.split('/');
        const pathParts = path.split('/');
        if (routeParts.length !== pathParts.length) continue;
        let matched = true;
        const params: Record<string, string> = {};
        for (let i = 0; i < routeParts.length; i++) {
          if (routeParts[i].startsWith(':')) {
            params[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
          } else if (routeParts[i] !== pathParts[i]) {
            matched = false;
            break;
          }
        }
        if (matched) {
          return { ...route, path, handler: { ...route.handler, _params: params } as any };
        }
      }
    }
    return null;
  }

  /** Handle WebSocket upgrade with auth hook */
  async handleUpgrade(
    req: Request,
    server: { upgrade: (req: Request, options?: any) => boolean }
  ): Promise<Response | undefined> {
    const url = new URL(req.url);
    const route = this.match(url.pathname);

    if (!route) return undefined;

    // Extract params from matched route
    const params = (route.handler as any)._params || {};

    // Run upgrade hook for auth
    let upgradeData: Record<string, unknown> = {};
    if (route.handler.upgrade) {
      const result = await route.handler.upgrade(req, url);
      if (result === null) {
        return new Response('Forbidden', { status: 403 });
      }
      upgradeData = result;
    }

    const upgraded = server.upgrade(req, {
      data: { path: url.pathname, params, ...upgradeData },
    });

    if (upgraded) return undefined as unknown as Response;
    return new Response('WebSocket upgrade failed', { status: 400 });
  }

  getHandlers(): {
    open: (ws: ServerWebSocket<WebSocketData>) => void;
    message: (ws: ServerWebSocket<WebSocketData>, message: string | Buffer) => void;
    close: (ws: ServerWebSocket<WebSocketData>, code: number, reason: string) => void;
    drain: (ws: ServerWebSocket<WebSocketData>) => void;
  } {
    return {
      open: (ws) => {
        const route = this.match(ws.data.path);
        route?.handler.open?.(ws);
      },
      message: (ws, message) => {
        const route = this.match(ws.data.path);
        route?.handler.message?.(ws, message);
      },
      close: (ws, code, reason) => {
        const route = this.match(ws.data.path);
        route?.handler.close?.(ws, code, reason);
      },
      drain: (ws) => {
        const route = this.match(ws.data.path);
        route?.handler.drain?.(ws);
      },
    };
  }

  get maxPayloadLength(): number {
    let max = 16 * 1024;
    for (const route of this.routes) {
      if (route.handler.maxPayloadLength && route.handler.maxPayloadLength > max) {
        max = route.handler.maxPayloadLength;
      }
    }
    return max;
  }

  get idleTimeout(): number {
    return this.routes[0]?.handler.idleTimeout ?? 120;
  }
}
