/**
 * Minimal template — bare bones Vajra app.
 */

export function minimalTemplate(name: string): Record<string, string> {
  return {
    'package.json': JSON.stringify({
      name,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'bun --watch src/index.ts',
        build: 'bun build src/index.ts --outdir dist --target bun',
        start: 'bun dist/index.js',
        test: 'bun test',
      },
      dependencies: {
        vajrajs: 'latest',
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

    'src/index.ts': `import { Vajra, logger, helmet } from 'vajrajs';

const app = new Vajra();

// Middleware
app.use(logger());
app.use(helmet());

// Routes
app.get('/', (c) => {
  return c.json({
    name: '${name}',
    version: '0.1.0',
    message: 'Vajra is running',
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start
const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  console.log(\`  ${name} running on http://localhost:\${port}\`);
});
`,

    '.env.example': `PORT=3000
NODE_ENV=development
`,
  };
}
