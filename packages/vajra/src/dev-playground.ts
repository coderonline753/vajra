/**
 * Vajra Dev Playground
 * Hidden dev-only route at /__vajra/ · browse routes, execute with auth, view config,
 * tail live logs, inspect modules. Disabled in production by default.
 *
 * app.use(devPlayground({ routes: () => app.routes() }));
 */

import type { Context } from './context';
import type { Middleware } from './middleware';

/* ═════════════ TYPES ═════════════ */

export interface PlaygroundRoute {
  method: string;
  path: string;
  summary?: string;
  tags?: string[];
  bodySchema?: unknown;
  querySchema?: unknown;
  paramsSchema?: unknown;
  responseSchema?: unknown;
}

export interface PlaygroundOptions {
  /** Base URL prefix. Default: /__vajra */
  prefix?: string;
  /** Function returning current registered routes */
  routes?: () => PlaygroundRoute[];
  /** Shared auth token for protection (request header x-vajra-dev). Undefined = open (only bind in dev). */
  token?: string;
  /** Enable only when this returns true. Default: NODE_ENV !== 'production' */
  enabled?: () => boolean;
  /** Log tail buffer (most recent logs). If provided, /logs tails from it. */
  logBuffer?: () => string[];
  /** Config snapshot for /config endpoint */
  configSnapshot?: () => Record<string, unknown>;
}

/* ═════════════ MIDDLEWARE ═════════════ */

export function devPlayground(options: PlaygroundOptions = {}): Middleware {
  const prefix = options.prefix ?? '/__vajra';
  const enabled = options.enabled ?? (() => (process.env.NODE_ENV ?? 'development') !== 'production');

  return async (ctx: Context, next) => {
    if (!enabled()) { await next(); return; }
    if (!ctx.path.startsWith(prefix)) { await next(); return; }

    if (options.token) {
      const supplied = ctx.header('x-vajra-dev') || ctx.query('token');
      if (supplied !== options.token) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    const subPath = ctx.path.slice(prefix.length) || '/';

    if (subPath === '/' || subPath === '') {
      return new Response(renderIndexHtml(prefix), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (subPath === '/routes.json') {
      const routes = options.routes?.() ?? [];
      return ctx.json(routes);
    }

    if (subPath === '/config.json') {
      const config = options.configSnapshot?.() ?? {};
      return ctx.json(redactSecrets(config));
    }

    if (subPath === '/logs.json') {
      const logs = options.logBuffer?.() ?? [];
      return ctx.json({ logs });
    }

    if (subPath === '/health.json') {
      return ctx.json({
        ok: true,
        uptime: (Date.now() - startedAt) / 1000,
        memory: tryMemory(),
        node: typeof process !== 'undefined' ? process.version : undefined,
      });
    }

    return new Response('Not Found', { status: 404 });
  };
}

const startedAt = Date.now();

function tryMemory(): { rss: number; heapUsed: number } | null {
  try {
    const mem = process.memoryUsage();
    return { rss: mem.rss, heapUsed: mem.heapUsed };
  } catch { return null; }
}

export function redactSecrets<T extends Record<string, unknown>>(config: T): T {
  const SENSITIVE = /password|secret|token|key|cred|auth|private/i;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (SENSITIVE.test(k)) {
      out[k] = typeof v === 'string' && v.length > 0 ? `***${v.length}***` : '***';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactSecrets(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/* ═════════════ HTML UI ═════════════ */

function renderIndexHtml(prefix: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vajra Dev Playground</title>
<style>
:root { color-scheme: light dark; --accent: #f59e0b; --bg: #0b0d12; --fg: #e7ecf0; --mute: #8a94a4; --card: #141922; --border: #263042; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.6 -apple-system, Segoe UI, Inter, Roboto, sans-serif; background: var(--bg); color: var(--fg); }
.container { max-width: 1100px; margin: 0 auto; padding: 24px; }
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .2px; }
.tag { display: inline-block; padding: 2px 8px; font-size: 11px; background: var(--card); border: 1px solid var(--border); border-radius: 4px; color: var(--mute); margin-left: 6px; }
.nav { display: flex; gap: 0; margin: 16px 0 24px; border-bottom: 1px solid var(--border); }
.nav button { background: none; border: none; color: var(--mute); padding: 10px 14px; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; }
.nav button.active { color: var(--fg); border-bottom-color: var(--accent); }
.panel { display: none; }
.panel.active { display: block; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; margin-bottom: 10px; }
.method { display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; letter-spacing: .5px; margin-right: 10px; }
.method.GET { background: #0e7fc4; color: white; }
.method.POST { background: #10a86b; color: white; }
.method.PUT { background: #d08312; color: white; }
.method.PATCH { background: #9c4ee6; color: white; }
.method.DELETE { background: #d94545; color: white; }
.path { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
.summary { color: var(--mute); font-size: 12px; margin-top: 4px; }
pre { background: #080a0f; border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow: auto; font-size: 12px; }
.empty { color: var(--mute); font-style: italic; padding: 20px 0; }
.footer { color: var(--mute); font-size: 12px; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--border); }
</style>
</head>
<body>
<div class="container">
<h1>Vajra Dev Playground <span class="tag">dev only</span></h1>
<div style="color: var(--mute); font-size: 12px;">Routes · Config · Logs · Health — introspection for the running app</div>

<div class="nav">
<button class="tab active" data-panel="routes">Routes</button>
<button class="tab" data-panel="config">Config</button>
<button class="tab" data-panel="logs">Logs</button>
<button class="tab" data-panel="health">Health</button>
</div>

<div id="routes" class="panel active"></div>
<div id="config" class="panel"></div>
<div id="logs" class="panel"></div>
<div id="health" class="panel"></div>

<div class="footer">Endpoint prefix: <code>${prefix}</code> — Vajra Dev Playground · protect with token for shared envs</div>
</div>

<script>
const prefix = ${JSON.stringify(prefix)};

document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  const panel = btn.dataset.panel;
  document.getElementById(panel).classList.add('active');
  loadPanel(panel);
}));

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function loadPanel(name) {
  if (name === 'routes') return loadRoutes();
  if (name === 'config') return loadConfig();
  if (name === 'logs') return loadLogs();
  if (name === 'health') return loadHealth();
}

async function loadRoutes() {
  const res = await fetch(prefix + '/routes.json');
  const routes = await res.json();
  const el = document.getElementById('routes');
  if (!routes.length) { el.innerHTML = '<div class="empty">No routes registered</div>'; return; }
  el.innerHTML = routes.map(r => \`
    <div class="card">
      <span class="method \${esc(r.method)}">\${esc(r.method)}</span>
      <span class="path">\${esc(r.path)}</span>
      \${r.summary ? \`<div class="summary">\${esc(r.summary)}</div>\` : ''}
    </div>\`).join('');
}

async function loadConfig() {
  const res = await fetch(prefix + '/config.json');
  const config = await res.json();
  document.getElementById('config').innerHTML = '<pre>' + esc(JSON.stringify(config, null, 2)) + '</pre>';
}

async function loadLogs() {
  const res = await fetch(prefix + '/logs.json');
  const data = await res.json();
  const el = document.getElementById('logs');
  if (!data.logs.length) { el.innerHTML = '<div class="empty">No logs captured — set logBuffer option</div>'; return; }
  el.innerHTML = '<pre>' + data.logs.map(esc).join('\\n') + '</pre>';
}

async function loadHealth() {
  const res = await fetch(prefix + '/health.json');
  const h = await res.json();
  document.getElementById('health').innerHTML = '<pre>' + esc(JSON.stringify(h, null, 2)) + '</pre>';
}

loadRoutes();
</script>
</body>
</html>`;
}
