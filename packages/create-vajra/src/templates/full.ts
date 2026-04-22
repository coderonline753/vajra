/**
 * Full template — production-ready Vajra app with all features.
 */

export function fullTemplate(name: string): Record<string, string> {
  return {
    'package.json': JSON.stringify({
      name,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'bun --watch src/index.ts',
        build: 'bun build src/index.ts --compile --outfile dist/server',
        start: './dist/server',
        test: 'bun test',
      },
      dependencies: {
        vajrajs: 'latest',
        zod: '^3.25.0',
      },
      devDependencies: {
        '@types/bun': 'latest',
      },
    }, null, 2),

    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: './dist',
        rootDir: './src',
        types: ['bun-types'],
      },
      include: ['src/**/*.ts'],
      exclude: ['node_modules', 'dist'],
    }, null, 2),

    '.gitignore': `node_modules/
dist/
.env
*.tsbuildinfo
`,

    '.env.example': `PORT=3000
NODE_ENV=development
JWT_SECRET=change-this-to-a-random-secret
`,

    'src/index.ts': `import { Vajra, logger, helmet, cors, registerHealthRoutes } from 'vajrajs';
import { userRoutes } from './routes/users';

const app = new Vajra({
  maxBodySize: 5 * 1024 * 1024, // 5MB
  requestTimeout: 30_000,
});

// Global middleware
app.use(logger());
// Use 'web-app' preset if you serve external images, fonts, or CDN assets.
// Use 'api' (default) for pure JSON backends.
app.use(helmet({ preset: 'web-app' }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Health checks
registerHealthRoutes(app);

// Routes
app.get('/', (c) => {
  return c.json({
    name: '${name}',
    version: '0.1.0',
    docs: '/health',
  });
});

userRoutes(app);

// Start
const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  console.log(\`  ${name} running on http://localhost:\${port}\`);
});
`,

    'src/routes/users.ts': `import { type Vajra, validate, jwt } from 'vajrajs';
import { z } from 'zod';

const createUserSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export function userRoutes(app: Vajra) {
  // Public
  app.get('/api/users', (c) => {
    return c.json({ users: [] });
  });

  app.get('/api/users/:id', (c) => {
    return c.json({ id: c.param('id'), name: 'Demo User' });
  });

  // Protected
  app.post('/api/users',
    jwt({ secret: JWT_SECRET }),
    validate({ body: createUserSchema }),
    async (c) => {
      const body = c.get('validatedBody') as z.infer<typeof createUserSchema>;
      return c.json({ created: body }, 201);
    }
  );
}
`,

    'src/routes/users.test.ts': `import { describe, it, expect } from 'bun:test';
import { Vajra, jwtSign } from 'vajrajs';
import { userRoutes } from './users';

describe('User Routes', () => {
  const app = new Vajra();
  userRoutes(app);

  it('GET /api/users returns list', async () => {
    const res = await app.handle(new Request('http://localhost/api/users'));
    expect(res.status).toBe(200);
  });

  it('GET /api/users/:id returns user', async () => {
    const res = await app.handle(new Request('http://localhost/api/users/42'));
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.id).toBe('42');
  });

  it('POST /api/users requires auth', async () => {
    const res = await app.handle(new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test', email: 'test@test.com' }),
    }));
    expect(res.status).toBe(401);
  });
});
`,
  };
}
