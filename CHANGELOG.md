# Changelog

All notable changes to Vajra will be documented here.
The format is based on Keep a Changelog · version scheme follows Semantic Versioning.

## [1.2.0] on 2026-04-22

Minor release. Adds an opt-in performance path and a peer acceleration package. No API breaks. All v1.0 and v1.0.1 code keeps working without changes.

### Added

- **`{ optimize: true }` Vajra option.** Opt-in fast path that uses `composeOptimized` (single shared next closure across the middleware chain) and per-route compile cache (first hit pays the compose cost, subsequent hits reuse the closed over handler). Default stays `false` so existing apps see no behavior change. Full parity tests cover both modes.
- **`@vajrajs/native` peer package, v0.1.0 on npm.** Optional shape compiled Zod validators. Install with `bun add @vajrajs/native` and call `registerNativeAcceleration()` once at app bootstrap. Vajra core auto detects the registration and routes validation through the fast path for schemas it can flatten. Pure fallback to `schema.parse` is always safe when the package is absent. Measured speedup on shape compilable schemas is 1.12x to 1.31x (10 to 30 percent).
- **`fastParse(schema, value)` helper** exported from `vajrajs`. Drop in fast equivalent of `schema.parse(value)`. Tries the native compiled validator first when available, re runs `schema.parse()` on any fast path failure so callers still see a proper ZodError with issues list. Cached per schema reference.
- **`composeOptimized` and `compose` exports** on the public surface for advanced users building custom pipelines.

### Changed

- `validate()` middleware and `contractRouter` now route every schema parse through `fastParse`. Happy path uses the native compiled validator when registered, error path stays on Zod so the structured VALIDATION_FAILED response shape is unchanged.
- README badge bumped to 905 tests passing.

### Performance

Honest wrk measurements on Ryzen 9600X with Bun 1.3.12, same methodology as v1.0 benches.

| Config | v1.0 | v1.2.0 safe | v1.2.0 optimize | Notes |
|---|---:|---:|---:|---|
| Minimal (no middleware) | 104K | 73K | 76K | v1.0.1 auto ALS wrap costs about 15 percent, v1.2 optimize flag recovers part of it |
| Batteries (helmet, cors, rate limit) | 76K | 61K | 64K | Same ALS overhead, small gain from optimize flag |
| Full (batteries + requestId) | 62K | 60K | 62K | Approximately flat |
| Validation heavy endpoint with @vajrajs/native registered | n/a | base | base x 1.2 to 1.3 | Where this release earns its name |

Historical claims about v1.2 hitting 200K or 115K batteries on Bun are retired. The real ceiling for a debuggable batteries included TypeScript framework on Bun sits in the 80 to 90K RPS range per instance without code generation. Horizontal scaling remains unlimited.

### Stability contract

- No API break from v1.0.x.
- `optimize: true` is opt in and ships off by default in v1.2.0. v1.2.1 will consider flipping default after field validation.
- Stability contract memo refreshed (plan_vajra_v1_to_v1_2_stability). Five framework defense layers and five user discipline rules remain locked.

### Tests

801 tests on v1.0.0 ship, 869 at v1.0.1, 905 at v1.2.0. New coverage in this release spans behavior parity between `compose` and `composeOptimized`, route level cache correctness, native accelerator integration with stub globalThis accelerator, `fastParse` fallback behavior, and structured error response shape under both modes.

## [1.0.1] on 2026-04-22

Stability + honesty patch. No API breaks. Fixes the concrete gaps flagged in
the v1.0 post-ship audit and two user-reported bugs (CLI + docs nav).

### Fixed

- **create-vajra CLI.** `bunx create-vajra my-app` failed with
  "Unknown command". The npm `create-*` convention was not wired to the
  `new` subcommand. The CLI now detects its invocation name and dispatches
  positional project names to `new` automatically. Version constant synced
  from 0.7.5 to 1.0.0. Patch release as `create-vajra@1.0.1`.
- **Docs navigation slide to top.** Clicking a docs sidebar link animated
  a smooth scroll to top because global CSS has
  `html { scroll-behavior: smooth }`. Vue Router's default `{ top: 0 }`
  inherited it. Docs to docs and home transitions now force
  `behavior: 'instant'` for a clean page swap. Hash anchors still scroll
  smoothly, back and forward restores `savedPosition`.
- **Upload rename attack.** Extension check accepted a file when either
  the magic byte or the filename extension matched the allow list. A PDF
  renamed to `.jpg` slipped through. Detected extension is now
  authoritative when magic byte detection succeeds, claimed filename
  extension is only consulted when detection returns null.

### Changed

- **RSD positioning, honest.** v1.0 shipped with RSD framed as enforced
  architecture. It is not enforced in types; a handler can call the data
  layer directly and compile fine. Docs (README + vajra.run in EN/HI/
  Hinglish) now say: enforced today = layer-tagged errors; not enforced =
  cross-layer discipline; v1.1 target = type-level enforcement. Closes the
  "your RSD is MVC mix" critique surface.
- **Contract `skipValidation` → `unsafeSkipValidation`.** The risk is now
  visible at call sites. Old name kept as deprecated alias for one release
  with a per-call console.warn; removed in v1.1.
- **AI pricing is config-driven.** New options `pricing` (merge on top of
  `DEFAULT_AI_PRICING`) and `onMissingPricing`. A one-time warning fires
  when a completion runs for a model without a pricing entry. Both
  `DEFAULT_AI_PRICING` and `ModelPricing` type are now public exports.
- **Data layer identifier safety.** Every public method that accepts a
  column, table, or join identifier validates the input against a strict
  regex and throws on violation. Raw escape hatches (`selectRaw`,
  `whereRaw`, `joinRaw`) stay for complex cases. `limit`/`offset` reject
  non-integer and negative values. Insert/update/delete gained
  `{ returning }` (PostgreSQL) and `transaction({ isolation, readOnly })`.
- **Automatic request context isolation.** `Vajra.handle()` now wraps
  every request in AsyncLocalStorage by default. `getRequestContext()` /
  `setRequestContext()` work without any middleware install. Closes the
  silent cross-request data-leak footgun when a service forgot to install
  `contextStorage()`.
- **Image + Video startup probes.** `imageProcessor()` probes `sharp`,
  `videoStreamer()` probes `ffmpeg -version` and `ffprobe -version` at
  factory time and logs platform-specific install hints (Debian/Arch/
  macOS/Windows) if missing. No more silent 500s on first upload in a
  mis-provisioned env.
- **Storage S3 documented.** The driver agnostic bring your own SDK
  pattern is now explicit with full JSDoc examples for AWS S3, Backblaze
  B2, and Cloudflare R2. Adapter code was already complete, docs gap
  caused the "incomplete" read in the audit.
- **Public `any` types cleaned.** Removed `any` from exported surface of
  `contract.ts`, `vajra.ts`, `openapi.ts`, and parts of `data.ts`. 63 to 45
  total, all remaining internal interop (Sharp and FFmpeg catch err, Bun TLS
  socket.data, Zod `_def`, pg and S3 SDK).

### Bench

- **Full-features benchmark restored.** `bench-http-full-features.ts` was
  parked on a stale "res.headers.set bug" claim. Verified middleware work
  correctly with `c.json()`. Honest number: **62K req/s, p99 11.64ms**
  with `helmet + requestId + cors + rate-limit`.
- `BENCHMARKS.md` v1.2 target section rewritten to match stability
  contract: +50% honest range (105-130K batteries) instead of the old
  200K+ overpromise.

### Tests

- 801 → 869 across 59 files. New coverage spans router malicious params,
  middleware error propagation, payload boundaries, prototype pollution,
  rate limiter burst isolation, queue concurrency cap, session store
  roundtrip, storage adapter edge cases, DB transaction rollback with
  async work, rename-to-allowed-extension upload attack, automatic ALS
  context isolation across parallel requests, and CLI scaffolding paths.

### Platform

- Bun-only (unchanged). Zod peer dep (unchanged). SSR experimental
  (unchanged). v1.2 `@vajrajs/native` WASM work continues as opt-in peer.

## [1.0.0] — 2026-04-20

**First stable release.** Ten new modules, 217+ new tests, Bun-only confirmed as long-term
platform bet, SSR marked experimental.

### Added

- **`upload`** — file upload with magic-byte MIME detection (13 formats), filename
  sanitization, size limits, extension whitelist, scan hook, disk spool option.
- **`createQueue`** — Redis-backed job queue with retry + exponential backoff, delayed
  jobs, priorities, BullMQ-compatible API, in-memory fallback for tests.
- **`session`** — signed cookie sessions with Redis/memory stores, regenerate, destroy,
  CSRF sync token helpers, skipPaths, rolling expiry.
- **`storage`** — pluggable storage adapter with local filesystem, S3/B2-compatible, and
  in-memory drivers. Signed URL support for local driver.
- **`createMetrics`** — Prometheus exposition format metrics (Counter, Gauge, Histogram),
  HTTP middleware, default process metrics, custom route labels.
- **`createI18n`** — locale detection (query/cookie/Accept-Language), CLDR pluralization,
  interpolation, nested keys, runtime addLocale, Intl-based formatters.
- **`createSigner`** — general-purpose HMAC signed URLs with expiry, method binding,
  maxUses counter (memory + Redis store), claims payload, middleware.
- **`defineContract` + `createClient` + `contractRouter`** — end-to-end type-safe REST
  via Zod. Single-contract server binding + typed client SDK generator.
- **`devPlayground`** — dev-only route at `/__vajra/` with routes browser, config viewer
  (redacted), logs tail, health snapshot. Token-guard option for shared envs.
- **`preserve` + `singleton`** — hot reload state preservation. Stable DB pools, Redis
  connections, in-memory caches across module re-eval on Bun `--watch`.
- **`vajra doctor`** — CLI command that diagnoses common issues (wrong Bun version,
  Express imports, raw `process.env`, weak default secrets, gitignore gaps).

### Changed

- **API surface locked at v1.0.** Breaking changes will go through semver-major.
- SSR module exposes a new `SSR_EXPERIMENTAL` marker and documents its experimental
  status. Code is complete and tested but lacks production dogfood — API may evolve
  before v2.0.
- Test count grew from 547 to 764 (core) + 14 to 20 (CLI).

### Platform

- **Bun-only is permanent.** See FAQ in README for the reasoning. Running raw `.ts`
  without a build step is a vision-aligned decision and won't be reversed.
- v1.2 will introduce optional `@vajrajs/native` WASM accelerator (opt-in, pure TS
  fallback always works).

## [0.7.5] — 2026-04-15

- Honest wrk benchmarks: 105K req/s minimal, 78K req/s with batteries.
- Removed "Fastest batteries-included framework" claim pending verified benchmarks.
- "Zero dependencies" → "one peer dependency (Zod)" across all copy.
- GitHub Search Console + sitemap.xml + robots.txt for vajra.run.
- Community UI upgrades: sidebar persist, emoji + GIF picker for posts.
- Docs: Peer Dependencies section in 3 languages (EN, HI, Hinglish).
- create-vajra CLI published at v0.7.6.

## [0.7.0] — 2026-04-14

- Beta release. 561 tests, 29 modules, 0 failures.
- Framework modules: Redis Rate Limiter, Migration Runner, Cluster, SSR with Islands +
  Streaming + Loader, defineModule (microservices), AI (Claude/GPT/Ollama providers,
  agents, guardrails), Email, Cron, Image, Video, Data/ORM with N+1 DataLoader.
- Website live at https://vajra.run with docs in 3 languages.
- npm: vajrajs@0.7.0, GitHub release, old 0.1.0-0.6.0 deprecated.

## [0.1.0] — 2026-04-13

- Initial npm publish. 290 tests, 45 source files.
- Security pillar (Helmet, CSRF, IP filter, Sanitize, HMAC, BOLA), Enterprise pillar
  (Health checks, Circuit breaker, RBAC, Tracing), AI-native pillar (multi-provider
  LLM, agents, guardrails), Microservices pillar (defineModule, EventBus, Saga).
