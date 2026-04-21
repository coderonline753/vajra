/**
 * Vajra Metrics Module
 * Prometheus exposition format · Counter, Gauge, Histogram, Summary primitives
 * HTTP middleware + default runtime metrics + /metrics endpoint handler.
 *
 * const m = createMetrics({ defaultMetrics: true });
 * app.use(m.middleware());
 * app.get('/metrics', m.handler());
 */

import type { Context } from './context';
import type { Middleware, Handler } from './middleware';

/* ═════════════ TYPES ═════════════ */

export interface MetricDefinition {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

export type LabelValues = Record<string, string | number>;

export interface HistogramOptions extends MetricDefinition {
  /** Bucket upper bounds in seconds (or unit of your choice). Default: HTTP-friendly. */
  buckets?: readonly number[];
}

export interface Counter {
  readonly name: string;
  inc(labels?: LabelValues, value?: number): void;
  reset(): void;
  collect(): PromSample[];
}

export interface Gauge {
  readonly name: string;
  set(value: number, labels?: LabelValues): void;
  inc(value?: number, labels?: LabelValues): void;
  dec(value?: number, labels?: LabelValues): void;
  reset(): void;
  collect(): PromSample[];
}

export interface Histogram {
  readonly name: string;
  observe(value: number, labels?: LabelValues): void;
  startTimer(labels?: LabelValues): () => number;
  reset(): void;
  collect(): PromSample[];
}

export interface PromSample {
  name: string;
  labels: LabelValues;
  value: number;
}

/* ═════════════ LABEL SERIALIZATION ═════════════ */

function labelKey(labels: LabelValues = {}, labelNames: readonly string[] = []): string {
  if (labelNames.length === 0) return '';
  const parts: string[] = [];
  for (const name of labelNames) {
    const val = labels[name];
    parts.push(`${name}=${val === undefined ? '' : String(val)}`);
  }
  return parts.join('|');
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(labels: LabelValues, labelNames: readonly string[]): string {
  if (labelNames.length === 0) return '';
  const parts: string[] = [];
  for (const name of labelNames) {
    const v = labels[name];
    if (v === undefined) continue;
    parts.push(`${name}="${escapeLabelValue(String(v))}"`);
  }
  return parts.length ? `{${parts.join(',')}}` : '';
}

/* ═════════════ COUNTER ═════════════ */

export function createCounter(def: MetricDefinition): Counter {
  const values = new Map<string, { labels: LabelValues; value: number }>();
  const labelNames = def.labelNames ?? [];

  return {
    name: def.name,
    inc(labels = {}, value = 1) {
      if (value < 0) throw new Error(`Counter ${def.name} cannot decrement`);
      const key = labelKey(labels, labelNames);
      const existing = values.get(key);
      if (existing) existing.value += value;
      else values.set(key, { labels: { ...labels }, value });
    },
    reset() { values.clear(); },
    collect() {
      return [...values.values()].map((e) => ({ name: def.name, labels: e.labels, value: e.value }));
    },
  };
}

/* ═════════════ GAUGE ═════════════ */

export function createGauge(def: MetricDefinition): Gauge {
  const values = new Map<string, { labels: LabelValues; value: number }>();
  const labelNames = def.labelNames ?? [];

  const getOrInit = (labels: LabelValues) => {
    const key = labelKey(labels, labelNames);
    let entry = values.get(key);
    if (!entry) { entry = { labels: { ...labels }, value: 0 }; values.set(key, entry); }
    return entry;
  };

  return {
    name: def.name,
    set(value, labels = {}) { getOrInit(labels).value = value; },
    inc(value = 1, labels = {}) { getOrInit(labels).value += value; },
    dec(value = 1, labels = {}) { getOrInit(labels).value -= value; },
    reset() { values.clear(); },
    collect() {
      return [...values.values()].map((e) => ({ name: def.name, labels: e.labels, value: e.value }));
    },
  };
}

/* ═════════════ HISTOGRAM ═════════════ */

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export function createHistogram(def: HistogramOptions): Histogram {
  const buckets = def.buckets ?? DEFAULT_BUCKETS;
  if (!buckets.every((b, i) => i === 0 || b > buckets[i - 1]!)) {
    throw new Error(`Histogram ${def.name} buckets must be strictly increasing`);
  }
  const labelNames = def.labelNames ?? [];

  interface HistEntry {
    labels: LabelValues;
    bucketCounts: number[];
    sum: number;
    count: number;
  }
  const entries = new Map<string, HistEntry>();

  const getOrInit = (labels: LabelValues): HistEntry => {
    const key = labelKey(labels, labelNames);
    let e = entries.get(key);
    if (!e) {
      e = {
        labels: { ...labels },
        bucketCounts: new Array(buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      entries.set(key, e);
    }
    return e;
  };

  return {
    name: def.name,
    observe(value, labels = {}) {
      const e = getOrInit(labels);
      e.sum += value;
      e.count++;
      for (let i = 0; i < buckets.length; i++) {
        if (value <= buckets[i]!) e.bucketCounts[i]!++;
      }
    },
    startTimer(labels = {}) {
      const start = performance.now();
      return () => {
        const seconds = (performance.now() - start) / 1000;
        this.observe(seconds, labels);
        return seconds;
      };
    },
    reset() { entries.clear(); },
    collect() {
      const samples: PromSample[] = [];
      for (const e of entries.values()) {
        // Cumulative buckets + +Inf
        let cumulative = 0;
        for (let i = 0; i < buckets.length; i++) {
          cumulative = e.bucketCounts[i]!; // already cumulative by bucket definition (≤ le)
          samples.push({
            name: `${def.name}_bucket`,
            labels: { ...e.labels, le: String(buckets[i]) },
            value: cumulative,
          });
        }
        samples.push({
          name: `${def.name}_bucket`,
          labels: { ...e.labels, le: '+Inf' },
          value: e.count,
        });
        samples.push({ name: `${def.name}_sum`, labels: e.labels, value: e.sum });
        samples.push({ name: `${def.name}_count`, labels: e.labels, value: e.count });
      }
      return samples;
    },
  };
}

/* ═════════════ REGISTRY ═════════════ */

export interface Registry {
  counter(def: MetricDefinition): Counter;
  gauge(def: MetricDefinition): Gauge;
  histogram(def: HistogramOptions): Histogram;
  register(metric: { collect: () => PromSample[]; name: string }, help: string, type: 'counter' | 'gauge' | 'histogram' | 'summary'): void;
  render(): string;
  resetAll(): void;
}

export function createRegistry(): Registry {
  interface RegisteredMetric {
    metric: { collect: () => PromSample[]; name: string; reset?: () => void };
    help: string;
    type: string;
  }
  const metrics: RegisteredMetric[] = [];

  const register: Registry['register'] = (metric, help, type) => {
    if (metrics.some((m) => m.metric.name === metric.name)) {
      throw new Error(`Metric ${metric.name} already registered`);
    }
    metrics.push({ metric, help, type });
  };

  return {
    counter(def) {
      const c = createCounter(def);
      register(c, def.help, 'counter');
      return c;
    },
    gauge(def) {
      const g = createGauge(def);
      register(g, def.help, 'gauge');
      return g;
    },
    histogram(def) {
      const h = createHistogram(def);
      register(h, def.help, 'histogram');
      return h;
    },
    register,
    render() {
      const lines: string[] = [];
      for (const { metric, help, type } of metrics) {
        lines.push(`# HELP ${metric.name} ${help}`);
        lines.push(`# TYPE ${metric.name} ${type}`);
        for (const sample of metric.collect()) {
          const labels = formatSampleLabels(sample.labels);
          lines.push(`${sample.name}${labels} ${formatValue(sample.value)}`);
        }
      }
      return lines.join('\n') + '\n';
    },
    resetAll() {
      for (const { metric } of metrics) {
        if (typeof metric.reset === 'function') metric.reset();
      }
    },
  };
}

function formatSampleLabels(labels: LabelValues): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${k}="${escapeLabelValue(String(labels[k]))}"`);
  }
  return `{${parts.join(',')}}`;
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) {
    if (v === Infinity) return '+Inf';
    if (v === -Infinity) return '-Inf';
    return 'NaN';
  }
  return String(v);
}

/* ═════════════ HTTP MIDDLEWARE BUNDLE ═════════════ */

export interface MetricsBundleOptions {
  registry?: Registry;
  /** Attach process-level default metrics (memory, event loop delay). Default: true */
  defaultMetrics?: boolean;
  /** Buckets for HTTP duration histogram (seconds). Default: Prom standard. */
  buckets?: readonly number[];
  /** Normalizes route template for label (default: ctx.path). Set to group dynamic routes. */
  routeLabel?: (ctx: Context) => string;
}

export interface MetricsBundle {
  registry: Registry;
  httpRequests: Counter;
  httpDuration: Histogram;
  httpInFlight: Gauge;
  middleware(): Middleware;
  handler(): Handler;
}

export function createMetrics(options: MetricsBundleOptions = {}): MetricsBundle {
  const registry = options.registry ?? createRegistry();
  const buckets = options.buckets;
  const routeLabel = options.routeLabel ?? ((ctx: Context) => ctx.path);

  const httpRequests = registry.counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
  });

  const httpDuration = registry.histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets,
  });

  const httpInFlight = registry.gauge({
    name: 'http_in_flight_requests',
    help: 'Number of in-flight HTTP requests',
    labelNames: ['method'],
  });

  if (options.defaultMetrics !== false) {
    registerDefaultMetrics(registry);
  }

  return {
    registry,
    httpRequests,
    httpDuration,
    httpInFlight,
    middleware() {
      return async (ctx, next) => {
        const method = ctx.method;
        const start = performance.now();
        httpInFlight.inc(1, { method });
        let status = 200;
        try {
          await next();
        } catch (err) {
          status = 500;
          throw err;
        } finally {
          const route = routeLabel(ctx);
          const duration = (performance.now() - start) / 1000;
          // Status won't reach us from the Response (returned from handler, not available here)
          // Caller can set ctx.set('__metrics_status', 404) etc.
          const override = ctx.get<number>('__metrics_status');
          if (typeof override === 'number') status = override;
          const labels = { method, route, status: String(status) };
          httpRequests.inc(labels);
          httpDuration.observe(duration, labels);
          httpInFlight.dec(1, { method });
        }
      };
    },
    handler() {
      return (ctx) => {
        const output = registry.render();
        return new Response(output, {
          status: 200,
          headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
        });
      };
    },
  };
}

/* ═════════════ DEFAULT RUNTIME METRICS ═════════════ */

function registerDefaultMetrics(registry: Registry): void {
  const memoryRss = registry.gauge({
    name: 'process_memory_rss_bytes',
    help: 'Resident Set Size memory in bytes',
  });
  const memoryHeap = registry.gauge({
    name: 'process_memory_heap_used_bytes',
    help: 'Heap used in bytes',
  });
  const uptime = registry.gauge({
    name: 'process_uptime_seconds',
    help: 'Process uptime in seconds',
  });

  const started = Date.now();

  // Refresh before each scrape by subclassing the collect of each metric
  const originalRender = registry.render;
  registry.render = function () {
    const mem = process.memoryUsage?.() ?? { rss: 0, heapUsed: 0 };
    memoryRss.set(mem.rss ?? 0);
    memoryHeap.set((mem as any).heapUsed ?? 0);
    uptime.set((Date.now() - started) / 1000);
    return originalRender.call(registry);
  };
}
