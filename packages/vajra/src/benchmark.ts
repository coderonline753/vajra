/**
 * Vajra Benchmark Suite
 * Built-in performance testing. Reproducible, fair, comprehensive.
 * Run: bun run benchmarks/run.ts
 *
 * @example
 *   const bench = createBenchmark();
 *   bench.add('JSON response', async () => {
 *     await app.handle(new Request('http://localhost/json'));
 *   });
 *   await bench.run();
 */

/* ═══════ TYPES ═══════ */

interface BenchmarkCase {
  name: string;
  fn: () => void | Promise<void>;
  warmup?: number;
  iterations?: number;
}

interface BenchmarkResult {
  name: string;
  opsPerSec: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  iterations: number;
  totalMs: number;
}

interface BenchmarkOptions {
  /** Warmup iterations before measuring. Default: 100 */
  warmup?: number;
  /** Measurement iterations. Default: 10000 */
  iterations?: number;
  /** Print results to console. Default: true */
  print?: boolean;
}

/* ═══════ BENCHMARK ENGINE ═══════ */

class Benchmark {
  private cases: BenchmarkCase[] = [];
  private options: Required<BenchmarkOptions>;
  private results: BenchmarkResult[] = [];

  constructor(options: BenchmarkOptions = {}) {
    this.options = {
      warmup: options.warmup ?? 100,
      iterations: options.iterations ?? 10000,
      print: options.print ?? true,
    };
  }

  /** Add a benchmark case */
  add(name: string, fn: () => void | Promise<void>, options?: { warmup?: number; iterations?: number }): this {
    this.cases.push({
      name,
      fn,
      warmup: options?.warmup,
      iterations: options?.iterations,
    });
    return this;
  }

  /** Run all benchmarks */
  async run(): Promise<BenchmarkResult[]> {
    this.results = [];

    if (this.options.print) {
      console.log('\n  Vajra Benchmark Suite');
      console.log('  ' + '─'.repeat(60));
    }

    for (const c of this.cases) {
      const result = await this.runCase(c);
      this.results.push(result);

      if (this.options.print) {
        const ops = result.opsPerSec >= 1000000
          ? `${(result.opsPerSec / 1000000).toFixed(2)}M`
          : result.opsPerSec >= 1000
            ? `${(result.opsPerSec / 1000).toFixed(1)}K`
            : `${result.opsPerSec.toFixed(0)}`;

        console.log(`  ${result.name.padEnd(35)} ${ops.padStart(10)} ops/sec  avg ${result.avgMs.toFixed(3)}ms  p99 ${result.p99Ms.toFixed(3)}ms`);
      }
    }

    if (this.options.print) {
      console.log('  ' + '─'.repeat(60));
      console.log(`  ${this.cases.length} benchmarks completed\n`);
    }

    return this.results;
  }

  /** Get results as JSON */
  toJSON(): BenchmarkResult[] {
    return this.results;
  }

  /** Get results as Markdown table */
  toMarkdown(): string {
    let md = '| Benchmark | ops/sec | avg (ms) | p50 (ms) | p95 (ms) | p99 (ms) |\n';
    md += '|-----------|---------|----------|----------|----------|----------|\n';

    for (const r of this.results) {
      const ops = r.opsPerSec >= 1000000
        ? `${(r.opsPerSec / 1000000).toFixed(2)}M`
        : r.opsPerSec >= 1000
          ? `${(r.opsPerSec / 1000).toFixed(1)}K`
          : `${r.opsPerSec.toFixed(0)}`;

      md += `| ${r.name} | ${ops} | ${r.avgMs.toFixed(3)} | ${r.p50Ms.toFixed(3)} | ${r.p95Ms.toFixed(3)} | ${r.p99Ms.toFixed(3)} |\n`;
    }

    return md;
  }

  private async runCase(c: BenchmarkCase): Promise<BenchmarkResult> {
    const warmup = c.warmup ?? this.options.warmup;
    const iterations = c.iterations ?? this.options.iterations;
    const isAsync = c.fn.constructor.name === 'AsyncFunction';

    // Warmup
    for (let i = 0; i < warmup; i++) {
      if (isAsync) await c.fn();
      else c.fn();
    }

    // Measure
    const durations: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      if (isAsync) await c.fn();
      else c.fn();
      durations.push(performance.now() - start);
    }

    // Calculate stats
    durations.sort((a, b) => a - b);
    const totalMs = durations.reduce((sum, d) => sum + d, 0);
    const avgMs = totalMs / iterations;

    return {
      name: c.name,
      opsPerSec: Math.round(1000 / avgMs),
      avgMs,
      minMs: durations[0],
      maxMs: durations[durations.length - 1],
      p50Ms: durations[Math.floor(iterations * 0.5)],
      p95Ms: durations[Math.floor(iterations * 0.95)],
      p99Ms: durations[Math.floor(iterations * 0.99)],
      iterations,
      totalMs,
    };
  }
}

/* ═══════ HTTP BENCHMARK HELPER ═══════ */

interface HttpBenchmarkOptions {
  /** Target URL */
  url: string;
  /** Number of concurrent connections. Default: 100 */
  connections?: number;
  /** Duration in seconds. Default: 10 */
  duration?: number;
  /** HTTP method. Default: GET */
  method?: string;
  /** Request headers */
  headers?: Record<string, string>;
  /** Request body */
  body?: string;
}

interface HttpBenchmarkResult {
  url: string;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  requestsPerSec: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  durationSec: number;
}

/**
 * Run HTTP benchmark against a running server.
 * Uses Bun's native fetch for high performance.
 */
async function httpBenchmark(options: HttpBenchmarkOptions): Promise<HttpBenchmarkResult> {
  const connections = options.connections || 100;
  const duration = (options.duration || 10) * 1000;
  const method = options.method || 'GET';

  const latencies: number[] = [];
  let totalRequests = 0;
  let successRequests = 0;
  let failedRequests = 0;
  const startTime = Date.now();

  // Run concurrent workers
  const workers = Array.from({ length: connections }, async () => {
    while (Date.now() - startTime < duration) {
      const reqStart = performance.now();
      try {
        const res = await fetch(options.url, {
          method,
          headers: options.headers,
          body: options.body,
        });
        if (res.status < 400) {
          successRequests++;
          // Consume body to free resources
          await res.text();
        } else {
          failedRequests++;
        }
      } catch {
        failedRequests++;
      }
      latencies.push(performance.now() - reqStart);
      totalRequests++;
    }
  });

  await Promise.all(workers);

  const actualDuration = (Date.now() - startTime) / 1000;
  latencies.sort((a, b) => a - b);

  return {
    url: options.url,
    totalRequests,
    successRequests,
    failedRequests,
    requestsPerSec: Math.round(totalRequests / actualDuration),
    avgLatencyMs: latencies.reduce((s, l) => s + l, 0) / latencies.length,
    p50LatencyMs: latencies[Math.floor(latencies.length * 0.5)] || 0,
    p95LatencyMs: latencies[Math.floor(latencies.length * 0.95)] || 0,
    p99LatencyMs: latencies[Math.floor(latencies.length * 0.99)] || 0,
    durationSec: actualDuration,
  };
}

/**
 * Print HTTP benchmark result to console.
 */
function printHttpResult(result: HttpBenchmarkResult): void {
  console.log(`\n  HTTP Benchmark: ${result.url}`);
  console.log('  ' + '─'.repeat(50));
  console.log(`  Total Requests:    ${result.totalRequests.toLocaleString()}`);
  console.log(`  Success:           ${result.successRequests.toLocaleString()}`);
  console.log(`  Failed:            ${result.failedRequests.toLocaleString()}`);
  console.log(`  Requests/sec:      ${result.requestsPerSec.toLocaleString()}`);
  console.log(`  Avg Latency:       ${result.avgLatencyMs.toFixed(2)}ms`);
  console.log(`  P50 Latency:       ${result.p50LatencyMs.toFixed(2)}ms`);
  console.log(`  P95 Latency:       ${result.p95LatencyMs.toFixed(2)}ms`);
  console.log(`  P99 Latency:       ${result.p99LatencyMs.toFixed(2)}ms`);
  console.log(`  Duration:          ${result.durationSec.toFixed(1)}s`);
  console.log('  ' + '─'.repeat(50) + '\n');
}

/* ═══════ PUBLIC API ═══════ */

/**
 * Create a benchmark suite.
 *
 * @example
 *   import { createBenchmark } from 'vajrajs';
 *   import { Vajra } from 'vajrajs';
 *
 *   const app = new Vajra();
 *   app.get('/json', (c) => c.json({ hello: 'world' }));
 *
 *   const bench = createBenchmark();
 *
 *   bench.add('JSON response', async () => {
 *     await app.handle(new Request('http://localhost/json'));
 *   });
 *
 *   bench.add('Parameterized route', async () => {
 *     await app.handle(new Request('http://localhost/users/42'));
 *   });
 *
 *   await bench.run();
 *   console.log(bench.toMarkdown());
 */
export function createBenchmark(options?: BenchmarkOptions): Benchmark {
  return new Benchmark(options);
}

export { httpBenchmark, printHttpResult };
export type { BenchmarkCase, BenchmarkResult, BenchmarkOptions, HttpBenchmarkOptions, HttpBenchmarkResult };
