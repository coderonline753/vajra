# @vajrajs/native

Optional acceleration peer package for [Vajra](https://www.npmjs.com/package/vajrajs). Shape-compiles Zod validators so hot-path REST endpoints skip Zod's polymorphic dispatch on every call.

Pure TypeScript in v0.1 (no WASM, no build step, no platform binaries). Vajra core auto-detects this package at startup and falls back to plain Zod cleanly when absent.

## Install

```bash
bun add @vajrajs/native
```

Then at app startup (usually `src/index.ts`):

```ts
import { registerNativeAcceleration } from '@vajrajs/native';
registerNativeAcceleration();
```

Vajra core picks this up via its `native-bridge.ts` and routes validation through the compiled fast path for schemas it can flatten.

## What v0.1 accelerates

- `z.string()` (no refinements)
- `z.number()` (no refinements)
- `z.boolean()`
- `z.null()`
- `z.object({ k: primitive })` single-level shapes
- `z.array(primitive)`

Schemas with `.min()`, `.max()`, `.email()`, `.uuid()`, `.regex()`, refinements, transforms, unions, intersections, optional, nullable, default, or nested objects fall back to `schema.parse()`. Result stays correct; only the fast path skips for those shapes.

## Measured speedup on this stack (Bun 1.3.12, Ryzen 9600X)

| Schema | `schema.parse()` | compiled | Speedup |
|---|---:|---:|---:|
| 4-field object (primitives) | ~20M ops/s | ~24M ops/s | **1.19x** |
| 8-field object (primitives) | ~13M ops/s | ~17M ops/s | **1.31x** |
| array of 10 numbers | ~10.5M ops/s | ~11.7M ops/s | **1.12x** |

Gains are in the 10-30% range for shape-compilable schemas. For end-to-end HTTP benchmarks, the framework overhead is dominated by Response and Headers construction, so the absolute RPS movement from this package alone is small. The win shows up in validation-heavy CRUD endpoints where body/query validation is called per request.

Run the bench yourself — there is a reference snippet in `src/index.ts` JSDoc.

## API

```ts
import { compileValidator, fastStringify, registerNativeAcceleration, isNativeRegistered } from '@vajrajs/native';
import { z } from 'zod';

const schema = z.object({ id: z.number(), name: z.string() });
const validate = compileValidator(schema);  // cached per schema reference

const parsed = validate({ id: 1, name: 'A' });  // { id: 1, name: 'A' }
validate({ id: 'wrong', name: 'A' });           // throws
```

`fastStringify(value, schema?)` is a placeholder in v0.1 (defers to `JSON.stringify`). Shape-compiled serialization is v0.3 scope.

## Roadmap

- **v0.2** · AssemblyScript to WASM backend for deep objects and regex pre-compile. Single `.wasm` file via Bun's WebAssembly support. Keep the same TS fallback.
- **v0.3** · Fast JSON stringify with shape-known paths (fast-json-stringify approach).
- **v0.4** · Fast router matcher (compiled regex tree).

## Design rules

- **No semver lie.** This package will bump semver-major whenever a user-visible behavior changes, even for perf-only releases.
- **Correctness over speed.** Every compiled path has a parity test against `schema.parse()`.
- **Fallback always safe.** An unknown Zod construct is never a hard error — it routes to the original Zod path.

## License

MIT
