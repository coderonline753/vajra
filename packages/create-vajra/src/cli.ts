#!/usr/bin/env bun
/**
 * Vajra CLI — Project scaffolding and development tools.
 */

import { parseArgs } from './args';
import { newProject } from './commands/new';
import { devServer } from './commands/dev';
import { generate } from './commands/generate';
import { build } from './commands/build';

const VERSION = '0.7.5';

const HELP = `
  Vajra CLI v${VERSION}
  Indestructible. Lightning Fast.

  Usage:
    vajra <command> [options]

  Commands:
    new <name>           Create a new Vajra project
    dev                  Start development server with hot reload
    generate <type>      Generate module, route, or middleware
    build                Build for production

  Options:
    --help, -h           Show help
    --version, -v        Show version

  Examples:
    vajra new my-api
    vajra new my-api --template full
    vajra dev
    vajra dev --port 4000
    vajra generate module users
    vajra generate route /api/products
    vajra build
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.version || args.flags.v) {
    console.log(VERSION);
    return;
  }

  if (args.flags.help || args.flags.h || args.command === 'help' || !args.command) {
    console.log(HELP);
    return;
  }

  switch (args.command) {
    case 'new':
      await newProject(args);
      break;
    case 'dev':
      await devServer(args);
      break;
    case 'generate':
    case 'g':
      await generate(args);
      break;
    case 'build':
      await build(args);
      break;
    default:
      console.error(`  Unknown command: ${args.command}\n  Run 'vajra --help' for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  process.exit(1);
});
