/**
 * vajra build — Build for production.
 */

import type { ParsedArgs } from '../args';

export async function build(args: ParsedArgs) {
  const entryPoint = (args.flags.entry as string) || 'src/index.ts';
  const outDir = (args.flags.outdir as string) || 'dist';
  const compile = args.flags.compile === true;

  console.log(`\n  Vajra Build`);
  console.log(`  Entry: ${entryPoint}`);
  console.log(`  Output: ${outDir}`);
  console.log(`  Mode: ${compile ? 'single binary' : 'bundle'}\n`);

  if (compile) {
    // Single binary compilation
    const proc = Bun.spawn(
      ['bun', 'build', entryPoint, '--compile', '--outfile', `${outDir}/server`],
      { cwd: process.cwd(), stdout: 'inherit', stderr: 'inherit' }
    );
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      console.log(`\n  Binary compiled: ${outDir}/server`);
      console.log(`  Run: ./${outDir}/server\n`);
    } else {
      console.error('\n  Build failed.\n');
      process.exit(1);
    }
  } else {
    // Bundle
    const proc = Bun.spawn(
      ['bun', 'build', entryPoint, '--outdir', outDir, '--target', 'bun', '--minify'],
      { cwd: process.cwd(), stdout: 'inherit', stderr: 'inherit' }
    );
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      console.log(`\n  Bundle complete: ${outDir}/`);
      console.log(`  Run: bun ${outDir}/index.js\n`);
    } else {
      console.error('\n  Build failed.\n');
      process.exit(1);
    }
  }
}
