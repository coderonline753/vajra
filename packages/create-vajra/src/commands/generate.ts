/**
 * vajra generate <type> <name> — Generate modules, routes, middleware.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ParsedArgs } from '../args';

const GENERATORS: Record<string, (name: string) => Record<string, string>> = {
  module: generateModule,
  route: generateRoute,
  middleware: generateMiddleware,
};

export async function generate(args: ParsedArgs) {
  const type = args.positionals[0];
  const name = args.positionals[1];

  if (!type || !name) {
    console.error('  Usage: vajra generate <type> <name>');
    console.error('  Types: module, route, middleware\n');
    process.exit(1);
  }

  const generator = GENERATORS[type];
  if (!generator) {
    console.error(`  Unknown generator type: ${type}`);
    console.error(`  Available: ${Object.keys(GENERATORS).join(', ')}\n`);
    process.exit(1);
  }

  const files = generator(name);

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(process.cwd(), filePath);
    const fileDir = fullPath.substring(0, fullPath.lastIndexOf('/'));

    if (existsSync(fullPath)) {
      console.log(`  ~ ${filePath} (already exists, skipped)`);
      continue;
    }

    mkdirSync(fileDir, { recursive: true });
    writeFileSync(fullPath, content);
    console.log(`  + ${filePath}`);
  }

  console.log(`\n  Generated ${type}: ${name}\n`);
}

function generateModule(name: string): Record<string, string> {
  const lower = name.toLowerCase();
  return {
    [`src/modules/${lower}/index.ts`]: `import { defineModule } from 'vajrajs';

export const ${lower}Module = defineModule({
  name: '${lower}',
  prefix: '/api/${lower}',

  routes: [
    {
      method: 'GET',
      path: '/',
      handler: (c) => c.json({ ${lower}: [] }),
    },
    {
      method: 'GET',
      path: '/:id',
      handler: (c) => c.json({ id: c.param('id') }),
    },
    {
      method: 'POST',
      path: '/',
      handler: async (c) => {
        const body = await c.body();
        return c.json({ created: body }, 201);
      },
    },
  ],

  actions: [
    {
      name: 'getById',
      handler: async (input: { id: string }) => {
        // TODO: implement
        return { id: input.id };
      },
    },
  ],

  async onInit() {
    console.log('${lower} module initialized');
  },
});
`,
    [`src/modules/${lower}/${lower}.test.ts`]: `import { describe, it, expect } from 'bun:test';
import { Vajra, ModuleRegistry } from 'vajrajs';
import { ${lower}Module } from './index';

describe('${name} Module', () => {
  it('mounts routes correctly', async () => {
    const registry = new ModuleRegistry();
    registry.register(${lower}Module);

    const app = new Vajra();
    registry.mountRoutes(app);

    const res = await app.handle(new Request('http://localhost/api/${lower}/'));
    expect(res.status).toBe(200);
  });
});
`,
  };
}

function generateRoute(name: string): Record<string, string> {
  const clean = name.replace(/^\//, '').replace(/\//g, '-');
  return {
    [`src/routes/${clean}.ts`]: `import type { Handler } from 'vajrajs';

export const get${capitalize(clean)}: Handler = (c) => {
  return c.json({ path: '${name}' });
};

export const post${capitalize(clean)}: Handler = async (c) => {
  const body = await c.body();
  return c.json({ created: body }, 201);
};
`,
  };
}

function generateMiddleware(name: string): Record<string, string> {
  const lower = name.toLowerCase();
  return {
    [`src/middleware/${lower}.ts`]: `import type { Middleware } from 'vajrajs';

export function ${lower}(): Middleware {
  return async (c, next) => {
    // Before handler
    const start = performance.now();

    const res = await next();

    // After handler
    const duration = (performance.now() - start).toFixed(2);
    res.headers.set('x-${lower}-time', \`\${duration}ms\`);

    return res;
  };
}
`,
  };
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
