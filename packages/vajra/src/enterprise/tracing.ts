/**
 * Vajra Tracing — Lightweight request tracing and instrumentation.
 * OpenTelemetry-compatible span format without requiring the OTel SDK.
 * When OTel SDK is installed, integrates automatically.
 */

import type { Middleware } from '../middleware';

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'SERVER' | 'CLIENT' | 'INTERNAL';
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'OK' | 'ERROR' | 'UNSET';
  attributes: Record<string, string | number | boolean>;
}

interface TracingOptions {
  serviceName?: string;
  headerName?: string;
  sampleRate?: number;
  onSpan?: (span: Span) => void;
  propagate?: boolean;
}

function generateId(bytes = 8): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function tracing(options: TracingOptions = {}): Middleware {
  const serviceName = options.serviceName ?? 'vajra';
  const headerName = options.headerName ?? 'traceparent';
  const sampleRate = options.sampleRate ?? 1.0;
  const onSpan = options.onSpan;
  const propagate = options.propagate ?? true;

  return async (c, next) => {
    // Sampling
    if (sampleRate < 1.0 && Math.random() > sampleRate) {
      return next();
    }

    // Parse incoming trace context (W3C Trace Context format)
    let traceId: string;
    let parentSpanId: string | undefined;
    const traceparent = c.header(headerName);

    if (traceparent && propagate) {
      const parts = traceparent.split('-');
      if (parts.length >= 3) {
        traceId = parts[1];
        parentSpanId = parts[2];
      } else {
        traceId = generateId(16);
      }
    } else {
      traceId = generateId(16);
    }

    const spanId = generateId(8);
    const startTime = performance.now();

    // Store trace context for downstream use
    c.set('traceId', traceId);
    c.set('spanId', spanId);

    let status: 'OK' | 'ERROR' = 'OK';
    let res: Response | undefined;

    try {
      res = await next();
      if (res.status >= 500) status = 'ERROR';
    } catch (err) {
      status = 'ERROR';
      throw err;
    } finally {
      const endTime = performance.now();
      const duration = Math.round((endTime - startTime) * 100) / 100;

      const span: Span = {
        traceId,
        spanId,
        parentSpanId,
        name: `${c.method} ${c.path}`,
        kind: 'SERVER',
        startTime,
        endTime,
        duration,
        status,
        attributes: {
          'service.name': serviceName,
          'http.method': c.method,
          'http.url': c.path,
          'http.status_code': res?.status ?? 500,
          'http.user_agent': c.header('user-agent') ?? '',
        },
      };

      onSpan?.(span);
    }

    // Propagate trace context in response
    if (propagate && res) {
      res.headers.set('x-trace-id', traceId);
      res.headers.set('x-span-id', spanId);
    }

    return res!;
  };
}

/** Create a child span for internal operations */
export function createSpan(
  name: string,
  traceId: string,
  parentSpanId: string,
  kind: 'CLIENT' | 'INTERNAL' = 'INTERNAL'
): {
  span: Span;
  end: (status?: 'OK' | 'ERROR', attributes?: Record<string, string | number | boolean>) => Span;
} {
  const spanId = generateId(8);
  const startTime = performance.now();

  const span: Span = {
    traceId,
    spanId,
    parentSpanId,
    name,
    kind,
    startTime,
    status: 'UNSET',
    attributes: {},
  };

  return {
    span,
    end(status: 'OK' | 'ERROR' = 'OK', attributes?: Record<string, string | number | boolean>) {
      span.endTime = performance.now();
      span.duration = Math.round((span.endTime - span.startTime) * 100) / 100;
      span.status = status;
      if (attributes) Object.assign(span.attributes, attributes);
      return span;
    },
  };
}
