/**
 * vajra dev — Start development server with hot reload.
 */

import type { ParsedArgs } from '../args';

export async function devServer(args: ParsedArgs) {
  const entryPoint = (args.flags.entry as string) || 'src/index.ts';
  const port = parseInt((args.flags.port as string) || '3000', 10);

  console.log(`\n  Vajra Dev Server`);
  console.log(`  Entry: ${entryPoint}`);
  console.log(`  Port: ${port}`);
  console.log(`  Hot reload: enabled\n`);

  const proc = Bun.spawn(['bun', '--watch', entryPoint], {
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
    },
  });

  // Handle SIGINT to gracefully stop
  process.on('SIGINT', () => {
    proc.kill();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    proc.kill();
    process.exit(0);
  });

  await proc.exited;
}
