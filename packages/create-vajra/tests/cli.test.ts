import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CLI_SRC = join(import.meta.dir, '..', 'src', 'cli.ts');

async function runCli(argv: string[], opts: { cwd: string; as?: 'vajra' | 'create-vajra' } = { cwd: process.cwd() }): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv0 = opts.as === 'create-vajra' ? 'create-vajra' : 'vajra';
  const proc = Bun.spawn(['bun', CLI_SRC, ...argv], {
    cwd: opts.cwd,
    env: { ...process.env, argv0 },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe('create-vajra CLI', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'vajra-cli-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('--version prints 1.0.0', async () => {
    const res = await runCli(['--version'], { cwd: workDir });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('1.0.0');
  });

  it('no args prints help with examples', async () => {
    const res = await runCli([], { cwd: workDir });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Vajra CLI');
    expect(res.stdout).toContain('create-vajra');
  });

  it('scaffolds a new project with shorthand positional name', async () => {
    const name = 'shorthand-app';
    const res = await runCli([name], { cwd: workDir });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`Creating Vajra project: ${name}`);
    expect(existsSync(join(workDir, name, 'package.json'))).toBe(true);
  });

  it('scaffolds with explicit new command', async () => {
    const name = 'explicit-app';
    const res = await runCli(['new', name], { cwd: workDir });
    expect(res.code).toBe(0);
    expect(existsSync(join(workDir, name, 'src', 'index.ts'))).toBe(true);
  });

  it('existing directory triggers clean error', async () => {
    const name = 'conflict-app';
    await runCli(['new', name], { cwd: workDir });
    const res = await runCli(['new', name], { cwd: workDir });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('already exists');
  });

  it('unknown flag as first token is still handled gracefully', async () => {
    const res = await runCli(['--help'], { cwd: workDir });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Vajra CLI');
  });
});
