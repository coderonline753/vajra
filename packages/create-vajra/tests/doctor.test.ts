import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { doctor } from '../src/commands/doctor';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * These tests drive the doctor() command against synthetic project directories
 * and assert that it runs without throwing (and does not call process.exit for
 * "warn-only" projects). We capture console output to verify checks fire.
 */

let tempRoots: string[] = [];

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(tmpdir() + '/vajra-doctor-test-');
  tempRoots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = join(root, name);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

afterAll(async () => {
  for (const r of tempRoots) {
    await rm(r, { recursive: true, force: true }).catch(() => {});
  }
});

function captureConsole(): { output: string[]; restore: () => void } {
  const original = console.log;
  const output: string[] = [];
  console.log = (...args: any[]) => { output.push(args.map(String).join(' ')); };
  return { output, restore: () => { console.log = original; } };
}

describe('doctor', () => {
  test('healthy project passes all checks', async () => {
    const root = await makeProject({
      'package.json': JSON.stringify({
        name: 'my-app',
        dependencies: { vajrajs: '^1.0.0', zod: '^3.0.0' },
        engines: { bun: '>=1.2' },
      }),
      '.env.example': 'PORT=3000\n',
      '.gitignore': 'node_modules\n.env\ndist\n',
      'src/index.ts': 'import { Vajra } from "vajrajs";\n',
      'src/index.test.ts': 'import { test } from "bun:test";\ntest("ok", () => {});\n',
    });

    const cap = captureConsole();
    try {
      await doctor({ command: 'doctor', positionals: [root], flags: {} });
    } finally {
      cap.restore();
    }
    const out = cap.output.join('\n');
    expect(out).toContain('project-root');
    expect(out).toContain('vajrajs-dep');
  });

  test('detects missing package.json', async () => {
    const root = await mkdtemp(tmpdir() + '/vajra-doctor-empty-');
    tempRoots.push(root);

    const cap = captureConsole();
    const originalExit = process.exit;
    let exitCode = 0;
    (process as any).exit = (code: number) => { exitCode = code; throw new Error('__exit'); };
    try {
      try { await doctor({ command: 'doctor', positionals: [root], flags: {} }); }
      catch (err) { if ((err as Error).message !== '__exit') throw err; }
    } finally {
      cap.restore();
      process.exit = originalExit;
    }
    expect(exitCode).toBe(1);
    expect(cap.output.join('\n')).toMatch(/No package\.json/);
  });

  test('detects missing vajrajs dependency', async () => {
    const root = await makeProject({
      'package.json': JSON.stringify({ name: 'no-vajra' }),
      '.gitignore': 'node_modules\n.env\n',
    });

    const cap = captureConsole();
    try {
      await doctor({ command: 'doctor', positionals: [root], flags: {} });
    } finally { cap.restore(); }
    expect(cap.output.join('\n')).toMatch(/vajrajs not found/);
  });

  test('detects Express import as error', async () => {
    const root = await makeProject({
      'package.json': JSON.stringify({
        name: 'mixed',
        dependencies: { vajrajs: '^1', express: '^4' },
      }),
      '.gitignore': 'node_modules\n.env\n',
      'src/app.ts': 'import express from "express";\n',
    });

    const cap = captureConsole();
    const originalExit = process.exit;
    (process as any).exit = () => { throw new Error('__exit'); };
    try {
      try { await doctor({ command: 'doctor', positionals: [root], flags: {} }); }
      catch (err) { if ((err as Error).message !== '__exit') throw err; }
    } finally {
      cap.restore();
      process.exit = originalExit;
    }
    expect(cap.output.join('\n')).toMatch(/Express import/);
  });

  test('detects missing gitignore entries', async () => {
    const root = await makeProject({
      'package.json': JSON.stringify({
        name: 'x',
        dependencies: { vajrajs: '^1', zod: '^3' },
      }),
      '.gitignore': 'dist\n', // missing node_modules and .env
    });
    const cap = captureConsole();
    try { await doctor({ command: 'doctor', positionals: [root], flags: {} }); }
    finally { cap.restore(); }
    expect(cap.output.join('\n')).toMatch(/gitignore missing/);
  });

  test('flags weak default secrets in .env', async () => {
    const root = await makeProject({
      'package.json': JSON.stringify({
        name: 'x',
        dependencies: { vajrajs: '^1', zod: '^3' },
      }),
      '.gitignore': 'node_modules\n.env\n',
      '.env.example': 'PORT=3000',
      '.env': 'JWT_SECRET="changeme"\nADMIN_PASSWORD=admin\n',
    });
    const cap = captureConsole();
    try { await doctor({ command: 'doctor', positionals: [root], flags: {} }); }
    finally { cap.restore(); }
    const text = cap.output.join('\n');
    expect(text).toMatch(/weak password|weak default/i);
  });
});
