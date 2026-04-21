# Vajra Benchmarks

These numbers are development machine measurements (Ryzen 9600X, 32GB DDR5, Bun 1.3.12)
taken with `wrk -t4 -c100 -d10s`. Your production numbers will differ. Use these for
relative comparison only.

For apples to apples production benchmarks, see the TechEmpower submission which is
planned but not yet posted.

## Run it yourself

```bash
# Terminal 1, start a server
bun run bench-http.ts                  # minimal, no middleware
bun run bench-http-batteries.ts        # helmet, cors, rate limit
bun run bench-http-full-features.ts    # helmet, requestId, cors, rate limit

# Terminal 2, apply load
wrk -t4 -c100 -d10s http://localhost:3001/json
```

## Current measured numbers

Methodology: 3 second warmup ignored, 10 second measurement, 4 threads, 100 connections,
fresh server restart between configs, small JSON response.

| Config | Measured RPS | p99 latency | Notes |
|---|---:|---:|---|
| Minimal | 74K | 12.37ms | no middleware |
| Batteries | 61K | 11.61ms | helmet, cors, rate limit |
| Full features | 59K | 11.48ms | batteries plus requestId |

With the optional `@vajrajs/native` peer registered and validation heavy endpoints, add
roughly 1.12 to 1.31x on the routes that actually call `validate()` or `contractRouter`.
Hello world benches like the above will not show that gain because they do no validation.

## Competitive position on the same hardware

| Framework | Minimal RPS | With production middleware |
|---|---:|---:|
| Pure Bun.serve fetch | 367K | not applicable |
| Bun.serve routes API | 558K | not applicable |
| Elysia (Bun, codegen) | 343K | roughly 250 to 320K |
| Hono (Bun) | 246K | roughly 150 to 220K |
| **Vajra** | **74K** | **61K** |
| Spring Boot (Java) | 30 to 80K | same range |

Elysia reaches 93 percent of pure Bun through runtime code generation, which places its
stack traces inside eval and VM1 line numbers rather than user source files. Vajra
chooses readable stack traces over codegen magic. Horizontal scaling remains unlimited
either way.

## Real world reality check

Synthetic benchmarks measure framework overhead on a hello world response. In production,
DB and network dominate. For a typical CRUD endpoint:

| Layer | Approximate time |
|---|---|
| Framework overhead (Vajra batteries) | 0.1 to 0.2 ms |
| JWT verify plus session lookup | 0.2 to 0.5 ms |
| Zod validation | 0.05 to 0.3 ms (faster with `@vajrajs/native`) |
| Single indexed DB query | 1 to 5 ms |
| Join or aggregate query | 5 to 50 ms |

The framework is 3 to 5 percent of response time in most real APIs. What matters is that
batteries overhead stays low so you do not pay for what you turn on.

## Methodology notes

- Warm up 3 seconds ignored before measurement.
- Fresh server restart between configs (GC state and hot paths matter).
- Keep alive enabled (default wrk).
- Response size small JSON (around 40 bytes) to minimise network effect.
- No artificial latency injection.
- All numbers reproducible from the `bench-*.ts` scripts in this repo.

## Why we do not claim "fastest framework"

Because it is unproven until TechEmpower publishes. Claims without reproducible data erode
trust. What we do claim with measurable data is a batteries included framework that
beats Spring Boot on Bun hardware, drops only modest percent when production middleware
loads, and keeps debuggable stack traces.
