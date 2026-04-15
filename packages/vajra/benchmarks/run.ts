/**
 * Vajra Framework Benchmark Suite
 * Run: bun run benchmarks/run.ts
 */

import { Router } from '../src/router';
import { Vajra } from '../src/vajra';
import { createBenchmark } from '../src/benchmark';
import { cors } from '../src/middleware';
import { helmet } from '../src/security/helmet';
import { rateLimit } from '../src/rate-limiter';

console.log(`\n  Vajra Benchmark Suite`);
console.log(`  Bun ${Bun.version} · ${navigator.hardwareConcurrency} cores · ${process.platform} ${process.arch}`);
console.log('  ' + '═'.repeat(60));

/* ═══════ ROUTER BENCHMARKS ═══════ */

console.log('\n  Router Matching (sync, 1M iterations):');

const router = new Router<string>();
router.add('GET', '/', 'home');
router.add('GET', '/users', 'users');
router.add('GET', '/users/:id', 'user');
router.add('POST', '/users', 'create');
router.add('GET', '/posts/:id/comments/:cid', 'comment');
router.add('GET', '/api/v1/products', 'products');
router.add('GET', '/api/v1/products/:id', 'product');
router.add('GET', '/api/v1/categories/:cat/products', 'catProducts');
router.add('GET', '/health', 'health');
router.add('GET', '/about', 'about');

function syncBench(name: string, fn: () => void, iterations = 1_000_000): void {
  for (let i = 0; i < 1000; i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const totalMs = performance.now() - start;
  const opsPerSec = Math.round(iterations / (totalMs / 1000));
  const label = opsPerSec >= 1_000_000 ? `${(opsPerSec / 1_000_000).toFixed(1)}M` : `${(opsPerSec / 1000).toFixed(0)}K`;
  console.log(`  ${name.padEnd(45)} ${label.padStart(10)} ops/sec`);
}

syncBench('Static route (/health)', () => { router.match('GET', '/health'); });
syncBench('Param route (/users/:id)', () => { router.match('GET', '/users/42'); });
syncBench('Multi-param (/posts/:id/comments/:cid)', () => { router.match('GET', '/posts/10/comments/5'); });
syncBench('Deep path (/api/v1/categories/:cat/products)', () => { router.match('GET', '/api/v1/categories/electronics/products'); });
syncBench('Not found', () => { router.match('GET', '/nonexistent'); });

/* ═══════ REQUEST HANDLING BENCHMARKS ═══════ */

console.log('\n  Request Handling (async, 50K iterations):');

// Minimal app
const minimal = new Vajra();
minimal.get('/json', (c) => c.json({ message: 'Hello, World!' }));
minimal.get('/text', (c) => c.text('Hello, World!'));
minimal.get('/users/:id', (c) => c.json({ id: c.params.id }));

// Batteries-included app
const batteries = new Vajra();
batteries.use(helmet());
batteries.use(cors({ origin: '*' }));
batteries.use(rateLimit({ max: 1_000_000 }));
batteries.get('/json', (c) => c.json({ message: 'Hello, World!' }));
batteries.get('/users/:id', (c) => c.json({ id: c.params.id }));

// 5 middleware chain
const mwApp = new Vajra();
for (let i = 0; i < 5; i++) mwApp.use(async (_c, next) => next());
mwApp.get('/json', (c) => c.json({ message: 'Hello, World!' }));

const bench = createBenchmark({ iterations: 50000, warmup: 500, print: false });

bench.add('JSON response (minimal)', async () => {
  await minimal.handle(new Request('http://localhost/json'));
});

bench.add('Text response (minimal)', async () => {
  await minimal.handle(new Request('http://localhost/text'));
});

bench.add('Param route /users/:id', async () => {
  await minimal.handle(new Request('http://localhost/users/42'));
});

bench.add('JSON + Helmet + CORS + RateLimit', async () => {
  await batteries.handle(new Request('http://localhost/json'));
});

bench.add('Param + Helmet + CORS + RateLimit', async () => {
  await batteries.handle(new Request('http://localhost/users/42'));
});

bench.add('5 middleware chain + JSON', async () => {
  await mwApp.handle(new Request('http://localhost/json'));
});

bench.add('404 Not Found', async () => {
  await minimal.handle(new Request('http://localhost/nonexistent'));
});

const results = await bench.run();

for (const r of results) {
  const ops = r.opsPerSec >= 1_000_000
    ? `${(r.opsPerSec / 1_000_000).toFixed(2)}M`
    : r.opsPerSec >= 1000
      ? `${(r.opsPerSec / 1000).toFixed(1)}K`
      : `${r.opsPerSec.toFixed(0)}`;

  console.log(`  ${r.name.padEnd(45)} ${ops.padStart(10)} ops/sec  p99 ${r.p99Ms.toFixed(3)}ms`);
}

/* ═══════ SUMMARY ═══════ */

console.log('\n  ' + '═'.repeat(60));
console.log('\n  Markdown:\n');
console.log(bench.toMarkdown());
