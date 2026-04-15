/**
 * vajra new <name> — Create a new Vajra project.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ParsedArgs } from '../args';
import { getTemplate } from '../templates/index';

export async function newProject(args: ParsedArgs) {
  const name = args.positionals[0];
  if (!name) {
    console.error('  Usage: vajra new <project-name>\n');
    process.exit(1);
  }

  const template = (args.flags.template as string) || 'minimal';
  const dir = join(process.cwd(), name);

  if (existsSync(dir)) {
    console.error(`  Directory '${name}' already exists.\n`);
    process.exit(1);
  }

  console.log(`\n  Creating Vajra project: ${name}`);
  console.log(`  Template: ${template}\n`);

  const files = getTemplate(template, name);

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(dir, filePath);
    const fileDir = fullPath.substring(0, fullPath.lastIndexOf('/'));

    mkdirSync(fileDir, { recursive: true });
    writeFileSync(fullPath, content);
    console.log(`  + ${filePath}`);
  }

  // Install dependencies
  console.log('\n  Installing dependencies...\n');

  const proc = Bun.spawn(['bun', 'install'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;

  console.log(`  Done! Your project is ready.\n`);
  console.log(`  Next steps:`);
  console.log(`    cd ${name}`);
  console.log(`    bun run dev\n`);
}
