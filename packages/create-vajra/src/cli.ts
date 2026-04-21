#!/usr/bin/env bun
/**
 * Vajra CLI — Project scaffolding and development tools.
 */

import { basename } from 'path';
import { parseArgs } from './args';
import { newProject } from './commands/new';
import { devServer } from './commands/dev';
import { generate } from './commands/generate';
import { build } from './commands/build';
import { doctor } from './commands/doctor';

const VERSION = '1.0.0';

const KNOWN_COMMANDS = new Set(['new', 'dev', 'generate', 'g', 'build', 'doctor', 'help']);

const HELP = `
  Vajra CLI v${VERSION}
  Indestructible. Lightning Fast.

  Usage:
    vajra <command> [options]
    create-vajra <project-name> [options]     (shortcut for 'vajra new')

  Commands:
    new <name>           Create a new Vajra project
    dev                  Start development server with hot reload
    generate <type>      Generate module, route, or middleware
    build                Build for production
    doctor               Diagnose common issues in a Vajra project

  Options:
    --help, -h           Show help
    --version, -v        Show version

  Examples:
    bunx create-vajra my-api
    vajra new my-api --template full
    vajra dev
    vajra dev --port 4000
    vajra generate module users
    vajra generate route /api/products
    vajra build
`;

/** When invoked as 'create-vajra', positional args are the project name, not a subcommand. */
function invokedAsCreate(argv0: string): boolean {
  const base = basename(argv0 ?? '').toLowerCase();
  return base.startsWith('create-vajra') || base === 'create-vajra.js';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.version || args.flags.v) {
    console.log(VERSION);
    return;
  }

  if (args.flags.help || args.flags.h || args.command === 'help') {
    console.log(HELP);
    return;
  }

  // npm `create-*` convention: `bunx create-vajra my-app` should imply `vajra new my-app`.
  // Also accept bare `vajra my-app` for the same behavior when the token is not a known command.
  const invokedFromCreate = invokedAsCreate(process.argv[1] ?? '');
  if (args.command && !KNOWN_COMMANDS.has(args.command) && (invokedFromCreate || !args.command.startsWith('-'))) {
    const name = args.command;
    await newProject({ ...args, command: 'new', positionals: [name, ...args.positionals] });
    return;
  }

  if (!args.command) {
    if (invokedFromCreate) {
      console.error(`  Missing project name.\n  Usage: bunx create-vajra <project-name>\n`);
      process.exit(1);
    }
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
    case 'doctor':
      await doctor(args);
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
