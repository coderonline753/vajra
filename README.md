# Vajra (वज्र)

**Indestructible. Lightning Fast.**

The batteries-included TypeScript backend framework built on Bun. 39 modules, one peer dependency (Zod), production-tested.

[![npm version](https://img.shields.io/npm/v/vajrajs.svg)](https://www.npmjs.com/package/vajrajs)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-923%20passing-brightgreen)](https://vajra.run)
[![Stable](https://img.shields.io/badge/status-stable-brightgreen)](https://vajra.run)

> **v1.2.1 Stable.** 39 modules, 923 tests, 0 failures. Production tested on [vajra.run](https://vajra.run).

## Why Vajra?

Most frameworks give you routing and leave you to figure out the rest. You end up with 30+ dependencies, breaking updates, and configuration nightmares. Vajra ships everything you need from day one.

**The problem Vajra solves:** Fast frameworks (Hono, Elysia) have no batteries. Batteries-included frameworks (NestJS, AdonisJS) are slow. Nobody gives you both. Vajra does.

| | Vajra | Express | Hono | Fastify | NestJS |
|---|---|---|---|---|---|
| **Routing + Middleware** | Yes | Yes | Yes | Yes | Yes |
| **WebSocket** | Built-in | Plugin | Plugin | Plugin | Plugin |
| **SSE** | Built-in | Manual | Manual | Manual | Manual |
| **Rate Limiting** | Built-in + Redis | Plugin | No | Plugin | Plugin |
| **Security (Helmet, CSRF, BOLA)** | Built-in | 3 plugins | No | Plugins | Plugins |
| **AI/LLM Agent** | Built-in | No | No | No | No |
| **SSR (Islands)** | Built-in | No | Partial | No | No |
| **Circuit Breaker** | Built-in | No | No | No | Plugin |
| **RBAC** | Built-in | No | No | No | Plugin |
| **Image Processing** | Built-in | Sharp | No | No | No |
| **Video Streaming** | Built-in + GPU | No | No | No | No |
| **Email (SMTP)** | Built-in | Nodemailer | No | No | No |
| **Cron Scheduler** | Built-in | node-cron | No | No | Plugin |
| **Migration Runner** | Built-in | Knex | No | No | TypeORM |
| **Cluster Manager** | Built-in | PM2 | No | No | No |
| **OpenAPI/Swagger** | Built-in | Plugin | Plugin | Plugin | Built-in |
| **Feature Flags** | Built-in | No | No | No | No |
| **External Dependencies** | 1 (Zod peer) | 30+ | 0 | 20+ | 50+ |

## Install

```bash
bun add vajrajs
```

Requires [Bun](https://bun.sh) v1.0+. TypeScript is built-in with Bun.

All public APIs are exported from the main package. Always import from `'vajrajs'`, not from internal paths like `'vajrajs/src/...'`.

```typescript
import { Vajra, validate, cors, helmet, rateLimit, jwt, session } from 'vajrajs';
```

## Quick Start

```typescript
import { Vajra, cors, logger, secureHeaders, rateLimit } from 'vajrajs';

const app = new Vajra();

app.use(logger());
app.use(secureHeaders());
app.use(cors({ origin: ['https://myapp.com'] }));
app.use(rateLimit({ max: 100, window: 60_000 }));

app.get('/', (c) => c.json({ message: 'Hello Vajra!' }));

app.get('/users/:id', (c) => {
  return c.json({ id: c.params.id });
});

app.group('/api/v1', (group) => {
  group.get('/posts', listPosts);
  group.post('/posts', createPost);
});

app.listen(3000);
```

```bash
bun run index.ts
```

## Architecture: RSD (recommended pattern)

Vajra is designed around **RSD** (Route, Service, Data), not MVC. Three layers, clear responsibilities.

```
Route   → Receives request, validates, calls service, returns response. Zero logic.
Service → Business rules, calculations, orchestration. Zero HTTP awareness.
Data    → Database queries only. Get, save, count. Zero logic.
```

```typescript
// Route (traffic cop)
app.post('/api/posts', auth(), async (c) => {
  const body = c.validated;
  const post = await postService.create(body, c.get('user'));
  return c.json({ success: true, data: post }, 201);
});

// Service (brain)
const postService = {
  async create(data, user) {
    if (user.karma < 10) throw new BusinessError('Need 10 karma to post');
    return postQueries.insert({ ...data, author_id: user.id });
  },
};

// Data (database)
const postQueries = {
  async insert(data) {
    return db.insert('posts', data);
  },
};
```

### What is enforced today vs. what is coming

**Enforced today**: every error carries its originating layer (`data`, `service`, `route`, `system`). Traces tell the truth. You know whether a 500 came from a broken query or a broken business rule without reading stack frames. Stripe style safe serialization keeps internals out of JSON responses. See `VajraError` and the hierarchy under `errors.ts`.

**Not yet enforced**: the type system does not block a route handler from calling the data layer directly. RSD today is a *recommended pattern* backed by tagged errors, not a compile time contract. Discipline is still yours.

**Roadmap**: type level layer enforcement. Route handlers will accept only service shaped inputs and direct `db.*` calls from a route file will stop compiling. Tracked in the roadmap.

MVC was built for desktop GUIs in 1979. RSD is built for APIs in 2026. The naming is ours, the discipline is old.

## All Modules

### Core
**Router, Context, Middleware, Validator, Static Files, Cookies, JWT**

```typescript
import { Vajra, validate, jwt, serveStatic, parseCookies } from 'vajrajs';
import { z } from 'zod';

app.post('/users', validate({
  body: z.object({ name: z.string().min(2), email: z.string().email() })
}), (c) => c.json({ user: c.body }, 201));

app.get('/protected', jwt({ secret: 'your-secret' }), (c) => c.json(c.state.user));

app.use(serveStatic({ root: './public' }));
```

### Security
**Helmet, CSRF, CORS, IP Filter, Sanitize, HMAC, BOLA, Content-Type Validation, SSRF Prevention, Request ID**

```typescript
import { helmet, csrf, ipFilter, sanitize, hmacVerify, bolaGuard, contentType, ssrfGuard, requestId } from 'vajrajs';

app.use(helmet());           // 15+ security headers
app.use(csrf({ cookie: true }));
app.use(sanitize());         // XSS, SQL injection, NoSQL injection
app.use(requestId());        // X-Request-ID on every response

app.post('/webhooks/stripe', hmacVerify({ secret: process.env.STRIPE_SECRET, header: 'stripe-signature' }), handler);

app.get('/users/:id/orders', bolaGuard({ paramKey: 'id', userKey: 'user.id' }), getOrders);
```

### Rate Limiting (Sliding Window + Token Bucket + Redis)
```typescript
import { rateLimit, tokenBucket, createRedisStore } from 'vajrajs';

// In-memory (single process)
app.use(rateLimit({ max: 100, window: 60_000 }));

// Token bucket (SPA-friendly, allows bursts)
app.use(tokenBucket({ capacity: 50, refillRate: 3 }));

// Redis (distributed, multi-process)
import Redis from 'ioredis';
const store = createRedisStore({ client: new Redis(), prefix: 'api:' });
app.use(rateLimit({ max: 100, store }));
```

### WebSocket
```typescript
app.ws('/chat', {
  upgrade(req) { return { userId: verifyToken(req) }; },  // Auth on upgrade
  open(ws) { ws.subscribe('general'); },
  message(ws, msg) { ws.publish('general', msg); },
  close(ws) { ws.unsubscribe('general'); },
});
```

### SSE (Server-Sent Events)
```typescript
app.get('/events', (c) => {
  return c.stream(async (stream) => {
    stream.writeEvent({ id: '1', event: 'update', data: JSON.stringify({ count: 42 }) });
  });
});
// Client reconnects with Last-Event-ID automatically
```

### AI Native
**Multi-provider LLM, Agent with Tools, Guardrails, Cost Tracking**

```typescript
import { createAI, createAgent, guardrails } from 'vajrajs';

const ai = createAI({ provider: 'claude', apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-sonnet-4-20250514' });

const agent = createAgent({
  ai,
  name: 'support-bot',
  instructions: 'You help users with technical questions.',
  tools: {
    searchDocs: {
      description: 'Search documentation',
      parameters: z.object({ query: z.string() }),
      handler: async ({ query }) => searchIndex(query),
    },
  },
});

app.post('/chat', async (c) => c.json(await agent.run(c.body.message)));

// Guardrails: PII masking, prompt injection detection
app.use('/ai/*', guardrails({ maxTokens: 4096, piiFilter: true, blockedTopics: ['violence'] }));
```

### SSR (Islands + Loaders + Streaming)
```tsx
// tsconfig: { "jsx": "react-jsx", "jsxImportSource": "vajrajs" }
import { defineRoute, island, atom, Suspense } from 'vajrajs/ssr';

// Server-rendered by default. Islands ship JS only where needed.
const AddToCart = island('AddToCart', ({ id }) => <button data-id={id}>Add</button>, { hydrate: 'visible' });

const page = defineRoute({
  async load({ params }) {
    const product = await db.products.findById(params.id);
    return { product };
  },
  meta({ data }) { return { title: data.product.name }; },
  render({ data }) { return <main><h1>{data.product.name}</h1><AddToCart id={data.product.id} /></main>; },
  cache: { type: 'swr', maxAge: 60 },
});

app.page('/products/:id', page);
```

### Data / ORM
**Query Builder, Schema, SQLite + PostgreSQL, Transactions, DataLoader, Migrations**

```typescript
import { createDatabase, createMigrationRunner, table, column } from 'vajrajs';

const db = createDatabase({ driver: 'postgres', url: process.env.DATABASE_URL });

// Query builder
const users = await db.from('users').where({ role: 'admin' }).orderBy('name').limit(10).execute();

// Insert, update, delete
await db.insert('users', { name: 'Vajra', email: 'hello@vajra.run' });
await db.update('users', { role: 'admin' }, { id: '123' });

// Transactions
await db.transaction(async (tx) => {
  await tx.insert('orders', { userId: 1, total: 100 });
  await tx.update('users', { balance: 0 }, { id: 1 });
});

// Migrations
const runner = createMigrationRunner(db, {
  migrations: [
    { name: '001_users', up: (db) => db.exec('CREATE TABLE users (...)'), down: (db) => db.exec('DROP TABLE users') },
  ],
});
await runner.up();      // Apply pending
await runner.down(1);   // Revert last
await runner.status();  // Show applied/pending
```

### Microservices
**Modules, Event Bus, Saga Transactions, Service Registry**

```typescript
import { defineModule, EventBus, Saga, ServiceRegistry } from 'vajrajs';

const userModule = defineModule({
  name: 'users',
  routes: (app) => { app.get('/users', listUsers); },
  events: { 'user.created': async (data) => sendWelcomeEmail(data.email) },
});

// Saga: distributed transactions with compensation
const orderSaga = new Saga('place-order')
  .step('reserve', reserveInventory, cancelReservation)
  .step('charge', chargePayment, refundPayment)
  .step('ship', createShipment, cancelShipment);
```

### Enterprise
**Health Checks, Circuit Breaker, RBAC, Distributed Tracing**

```typescript
import { healthCheck, circuitBreaker, rbac, tracing } from 'vajrajs';

const { health, live, ready } = healthCheck({ checks: [{ name: 'db', check: () => db.ping() }] });
app.get('/health', health);
app.get('/health/live', live);
app.get('/health/ready', ready);

const paymentBreaker = circuitBreaker({ failureThreshold: 5, resetTimeout: 30_000 });
app.post('/pay', paymentBreaker, processPayment);

const roles = rbac({ roles: ['viewer', 'editor', 'admin'], hierarchy: { admin: ['editor'], editor: ['viewer'] } });
app.delete('/posts/:id', roles.require('admin'), deletePost);
```

### Smart Query (GraphQL Killer)
```typescript
import { smartQuery, defineResource } from 'vajrajs';

const userResource = defineResource({
  table: 'users',
  fields: { id: true, name: true, email: { selectable: true, filterable: true }, password: { hidden: true } },
  relations: { posts: { type: 'hasMany', resource: 'posts', foreignKey: 'author_id' } },
});

app.get('/api/users', smartQuery(userResource), handler);
// GET /api/users?fields=name,email&include=posts&filter[email][like]=@gmail&sort=-created_at
```

### Media
**Image Processing (Sharp, URL transforms) + Video Streaming (HLS, NVENC GPU)**

```typescript
import { imageProcessor, videoStreamer, detectGPU } from 'vajrajs';

app.use('/images', imageProcessor({ dir: './uploads', cache: './cache', maxWidth: 4096 }));
// GET /images/photo.jpg?w=300&h=200&format=webp&q=80

app.use('/videos', videoStreamer({ dir: './videos', hlsDir: './hls' }));
// Range requests, HLS adaptive streaming, GPU encode (NVENC)
const gpu = await detectGPU();  // { nvidia: true, encoder: 'h264_nvenc' }
```

### Utilities
**Email, Cron, Config, Logger, Feature Flags, OpenAPI, Plugin System**

```typescript
import { createMailer, createScheduler, defineConfig, createLogger, createFeatureFlags, openapi, definePlugin } from 'vajrajs';

// Email (built-in SMTP)
const mailer = createMailer({ host: 'smtp.example.com', port: 587, user: 'x', pass: 'y' });
await mailer.send({ to: 'user@x.com', subject: 'Hello', html: '<h1>Hi</h1>' });

// Cron
const cron = createScheduler();
cron.add({ name: 'cleanup', expression: '0 3 * * *', handler: () => cleanOldSessions() });
cron.add({ name: 'heartbeat', interval: '30s', handler: () => pingServices() });

// Config (Zod-validated, env auto-read)
const config = defineConfig({ port: z.coerce.number().default(3000), database: z.object({ url: z.string().url() }) });

// Logger (structured JSON, sampling)
const log = createLogger({ level: 'info', service: 'api' });
log.info('User created', { userId: '123' }); // JSON output with traceId

// Feature flags
const flags = createFeatureFlags({ 'new-checkout': { enabled: true, percentage: 50 } });
if (flags.isEnabled('new-checkout', { userId })) { ... }

// OpenAPI (auto-generated from Zod schemas)
app.use('/docs', openapi({ title: 'My API', version: '1.0.0' }));

// Plugin
const myPlugin = definePlugin({ name: 'redis', setup(app) { app.decorate('redis', new Redis()); } });
app.plugin(myPlugin);
```

### Cluster (Multi-Process + Deploy Helpers)
```typescript
import { cluster, generateNginxUpstream, generateSystemdService } from 'vajrajs';

// Run 4 workers on ports 3000-3003
cluster({ script: './src/index.ts', workers: 4, basePort: 3000, healthPath: '/health/live' });

// Generate Nginx + systemd configs
console.log(generateNginxUpstream({ workers: 4, domain: 'myapp.com', websocket: true, ssl: { cert: '...', key: '...' } }));
console.log(generateSystemdService({ name: 'myapp', script: '/opt/app/cluster.ts', user: 'deploy' }));
```

### Error Handling (RSD-Aligned)
13 typed error classes, Stripe-level responses. Errors know which layer they came from.

```typescript
import { NotFoundError, BusinessError, ValidationError, AuthError, RateLimitError } from 'vajrajs';

// Data layer
throw new NotFoundError('User', '123');       // 404: User '123' not found

// Service layer
throw new BusinessError('Cannot cancel shipped order');  // 422
throw new RateLimitError('Slow down', 30);               // 429 with retryAfter

// Route layer
throw new AuthError('Session expired', 'TOKEN_EXPIRED'); // 401
throw new ValidationError([{ field: 'email', message: 'Invalid' }]); // 400

// All errors serialize to: { success: false, error: { code, message, retryable, details } }
```

## Benchmarks

Real HTTP benchmarks using `wrk -t4 -c100 -d10s`. Same machine (Ryzen 5 9600X, 32GB DDR5), same tool.

**Vajra vs Others (actual HTTP, not internal):**

| Framework | Req/sec | Notes |
|-----------|---------|-------|
| Fastify (Node 24) | 167,000 | Routing only |
| Hono (Bun) | 153,000 | Routing only |
| **Vajra minimal** (Bun) | **105,000** | 39 modules loaded |
| Express (Node 24) | 95,000 | Routing only |
| **Vajra + batteries** (Bun) | **78,000** | Helmet + CORS + Rate Limit |

Vajra ships 39 modules built-in. Others ship routing only. Add security headers, CORS, rate limiting, JWT, and validation to any framework and the gap closes.

**Internal benchmarks (app.handle, no network):**

| Metric | Result |
|--------|--------|
| Static route lookup | 45,200,000 ops/sec |
| JSON response | 434,000 ops/sec |
| With batteries | 225,000 ops/sec |
| p99 latency | 0.008ms |

## Scaffold

```bash
bunx create-vajra my-app
cd my-app
bun dev
```

## Documentation

Full docs in 3 languages (English, Hindi, Hinglish): [vajra.run/docs](https://vajra.run/docs)

99 pages covering every module with code examples.

## Philosophy

**"Ek baar banao, saalon tak mat chedo."** (Build once, don't touch for years.)

Vajra will never:
- Add "use client" / "use server" directives
- Ship 4 caching layers with magic defaults
- Require code generation steps
- Break your app on major version updates
- Need 50+ dependencies for basic functionality (Vajra needs only Zod)

## Contributing

Contributions welcome. Open an issue first to discuss what you'd like to change.

## License

MIT
