# Migration Guide from Vajra 0.x to 1.0

Vajra 1.0 is the first stable release. Tier 3 projects can now adopt it with confidence
about API stability. This guide covers everything you need to upgrade from 0.7.x.

## TL;DR

For most 0.7.x users, the migration is **zero code changes**. All existing exports are
preserved. New modules are additive.

The only behavior change is in how you treat **SSR**. It is now explicitly labelled
experimental. If your app depends on SSR in production, review the SSR section below.

## Install

```bash
bun add vajrajs@1.0.0
```

`zod` remains a peer dependency:

```bash
bun add zod
```

## What is new in 1.0

Ten new modules ship alongside everything from 0.7.x. You can adopt them incrementally.

| New module | Use case |
|---|---|
| `upload` | File uploads with magic-byte validation |
| `createQueue` | Job queue (Redis or memory) |
| `session` | Cookie-signed sessions (Redis or memory) |
| `storage` | Local + S3/B2 pluggable storage with signed URLs |
| `createMetrics` | Prometheus exposition format |
| `createI18n` | i18n + pluralisation + locale detection |
| `createSigner` | General-purpose signed URLs |
| `defineContract` | End-to-end type-safe REST (server + client) |
| `devPlayground` | Dev-only introspection route at `/__vajra/` |
| `preserve` | Hot reload state preservation |

See `CHANGELOG.md` for full details.

## Breaking changes

**None.** All 0.7.x exports remain with identical signatures.

## Behaviour clarifications (not breaking, but worth knowing)

### SSR is experimental

The `vajrajs/ssr` subpath export (and all SSR features — Islands, streaming, loaders,
hydration) now ship with an `SSR_EXPERIMENTAL = true` marker.

**What this means:** the code is production-quality and well-tested (83+ tests). The API
may still shift before Vajra 2.0. If you use SSR in production, treat it as you would any
pre-1.0 feature: pin the Vajra version and review changelogs before upgrading.

**Recommendation:** for user-facing production apps, pair Vajra backend with Vue 3 or
React 19 on the frontend. Use Vajra SSR where dogfooding is part of the value (early
adopters, internal dashboards, marketing sites).

### Node support: none, ever

Vajra is Bun-only. This is not a bug or a gap. It is a deliberate vision decision documented
in `docs/why-bun-only.md`. Adding Node support would require a build step, dual
distribution, and polyfills for Bun-native APIs — all of which violate the "ship raw .ts,
no build, no magic" vision.

If you need Node-compatible code, extract framework-agnostic business logic into pure TS
files and run them under Node separately, or use Bun as your Node.

## Typical upgrade path

1. Bump `vajrajs` in `package.json` to `^1.0.0`.
2. Run `bun install`.
3. Run `bun test`. All existing tests should pass unchanged.
4. Optionally adopt new modules as needed. Start with one — file upload, session, or
   metrics are common first picks.
5. Run `bunx vajra doctor` from your project root. It will flag common pitfalls (Express
   imports, weak default secrets, missing gitignore entries).

## Example: adopting the session module

Before 1.0, you likely rolled your own JWT-based auth using `jwt` + `cookie`. 1.0 adds a
proper session middleware:

```ts
import { Vajra, session, createRedisSessionStore } from 'vajrajs';

const app = new Vajra();

app.use(session({
  secret: process.env.SESSION_SECRET!,
  store: createRedisSessionStore(redisClient),
  maxAge: 86400,
}));

app.post('/login', async (ctx) => {
  const s = ctx.get('session');
  s.userId = await authenticate(await ctx.body());
  return ctx.json({ ok: true });
});
```

`ctx.get('session')` returns a `SessionHandle` — it feels like a plain object but auto-saves
on response. JWT remains available for token auth use cases.

## Example: adopting typed REST contract

Before 1.0, client and server shared only Zod schemas. 1.0 adds a single-source-of-truth
contract that generates a fully-typed client:

```ts
// shared/contract.ts
import { defineContract } from 'vajrajs';
import { z } from 'zod';

export const api = defineContract({
  createUser: {
    method: 'POST',
    path: '/users',
    body: z.object({ name: z.string(), email: z.string().email() }),
    response: z.object({ id: z.string() }),
  },
});
```

```ts
// server/index.ts
import { contractRouter } from 'vajrajs';
import { api } from '../shared/contract';

const routes = contractRouter(api, {
  createUser: async ({ body }) => ({ id: uuid() }),
});
// register each route on your Vajra app
```

```ts
// client/index.ts
import { createClient } from 'vajrajs';
import { api } from '../shared/contract';

const client = createClient(api, { baseUrl: 'https://api.example.com' });
const user = await client.createUser({ body: { name: 'x', email: 'x@y.z' } });
//    ^ typed as { id: string } — no manual types needed
```

Types flow from the single contract to both sides. Client validates responses against the
contract by default.

## Questions

Open an issue at https://github.com/coderonline753/vajra/issues — include which 0.x version
you upgraded from and any errors you hit.
