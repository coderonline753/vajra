/**
 * vajra doctor — diagnose common issues in a Vajra project.
 * Checks: Bun version, Node-only imports, insecure defaults, outdated vajrajs,
 * missing .env, common misconfigurations.
 */

import type { ParsedArgs } from '../args';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/* ═════════════ CHECK TYPES ═════════════ */

type Severity = 'info' | 'warn' | 'error';

interface Finding {
  severity: Severity;
  check: string;
  message: string;
  fix?: string;
}

const MIN_BUN_MAJOR = 1;
const MIN_BUN_MINOR = 2;

/* ═════════════ MAIN ═════════════ */

export async function doctor(args: ParsedArgs): Promise<void> {
  const cwd = args.positionals[0] ?? process.cwd();
  const findings: Finding[] = [];

  console.log(`\n  Vajra Doctor — checking ${cwd}\n`);

  await checkBunVersion(findings);
  await checkProjectRoot(cwd, findings);
  await checkPackageJson(cwd, findings);
  await checkEnvFiles(cwd, findings);
  await checkSourceAntiPatterns(cwd, findings);
  await checkGitignore(cwd, findings);
  await checkTestSetup(cwd, findings);

  // Report
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warn');
  const infos = findings.filter((f) => f.severity === 'info');

  for (const f of [...errors, ...warnings, ...infos]) {
    const icon = f.severity === 'error' ? 'ERR' : f.severity === 'warn' ? 'WRN' : 'OK ';
    console.log(`  [${icon}] ${f.check}: ${f.message}`);
    if (f.fix) console.log(`          → fix: ${f.fix}`);
  }

  console.log(`\n  Summary: ${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} ok`);
  if (errors.length === 0 && warnings.length === 0) {
    console.log('  All checks passed. Looks good!');
  }
  console.log();

  if (errors.length > 0) process.exit(1);
}

/* ═════════════ INDIVIDUAL CHECKS ═════════════ */

async function checkBunVersion(findings: Finding[]): Promise<void> {
  const version = typeof Bun !== 'undefined' ? Bun.version : null;
  if (!version) {
    findings.push({
      severity: 'error',
      check: 'runtime',
      message: 'Not running under Bun. Vajra is Bun-only.',
      fix: 'Install Bun: curl -fsSL https://bun.sh/install | bash',
    });
    return;
  }

  const [majStr, minStr] = version.split('.');
  const maj = parseInt(majStr!, 10);
  const min = parseInt(minStr!, 10);

  if (maj < MIN_BUN_MAJOR || (maj === MIN_BUN_MAJOR && min < MIN_BUN_MINOR)) {
    findings.push({
      severity: 'warn',
      check: 'bun-version',
      message: `Bun ${version} is older than ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR} (recommended for Vajra).`,
      fix: 'Upgrade: bun upgrade',
    });
  } else {
    findings.push({ severity: 'info', check: 'bun-version', message: `Bun ${version}` });
  }
}

async function checkProjectRoot(cwd: string, findings: Finding[]): Promise<void> {
  try {
    await stat(join(cwd, 'package.json'));
    findings.push({ severity: 'info', check: 'project-root', message: 'package.json present' });
  } catch {
    findings.push({
      severity: 'error',
      check: 'project-root',
      message: 'No package.json found at ' + cwd,
      fix: 'Run from your project root, or: vajra new <name>',
    });
  }
}

async function checkPackageJson(cwd: string, findings: Finding[]): Promise<void> {
  let pkg: any = null;
  try {
    pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  } catch {
    return;
  }

  const vajraVersion = pkg.dependencies?.vajrajs ?? pkg.devDependencies?.vajrajs;
  if (!vajraVersion) {
    findings.push({
      severity: 'warn',
      check: 'vajrajs-dep',
      message: 'vajrajs not found in dependencies',
      fix: 'bun add vajrajs',
    });
  } else {
    findings.push({ severity: 'info', check: 'vajrajs-dep', message: `vajrajs ${vajraVersion}` });
  }

  const zodVersion = pkg.dependencies?.zod ?? pkg.devDependencies?.zod;
  if (!zodVersion) {
    findings.push({
      severity: 'warn',
      check: 'zod-peer',
      message: 'zod (peer dependency) not installed',
      fix: 'bun add zod',
    });
  }

  if (pkg.main && typeof pkg.main === 'string' && !pkg.main.endsWith('.ts')) {
    findings.push({
      severity: 'info',
      check: 'package-main',
      message: `"main" points to ${pkg.main}`,
    });
  }

  if (pkg.engines?.node && !pkg.engines?.bun) {
    findings.push({
      severity: 'warn',
      check: 'engines',
      message: 'package.json "engines" only specifies Node — Vajra runs on Bun',
      fix: 'Add: "engines": { "bun": ">=1.2" }',
    });
  }
}

async function checkEnvFiles(cwd: string, findings: Finding[]): Promise<void> {
  const hasExample = await fileExists(join(cwd, '.env.example'));
  const hasEnv = await fileExists(join(cwd, '.env'));

  if (!hasExample) {
    findings.push({
      severity: 'warn',
      check: 'env-example',
      message: '.env.example is missing',
      fix: 'Create .env.example with documented vars (no secrets)',
    });
  }

  if (hasEnv) {
    // Scan for obviously bad values
    try {
      const content = await readFile(join(cwd, '.env'), 'utf8');
      if (/password=(password|123|changeme|admin)/i.test(content)) {
        findings.push({
          severity: 'warn',
          check: 'env-weak-password',
          message: '.env contains a weak password value',
          fix: 'Rotate credentials before going to production',
        });
      }
      if (/_secret=["']?(secret|changeme|default)/i.test(content)) {
        findings.push({
          severity: 'warn',
          check: 'env-weak-secret',
          message: '.env contains a weak default secret',
          fix: 'Generate strong secrets: openssl rand -hex 32',
        });
      }
    } catch { /* ignore */ }
  }
}

async function checkSourceAntiPatterns(cwd: string, findings: Finding[]): Promise<void> {
  const srcDir = join(cwd, 'src');
  const files: string[] = [];
  try {
    await walkTs(srcDir, files);
  } catch { return; }

  const patterns: Array<{ pattern: RegExp; check: string; message: string; severity: Severity; fix?: string }> = [
    {
      pattern: /require\s*\(/,
      check: 'commonjs-require',
      message: 'Using require() — prefer ES imports',
      severity: 'warn',
      fix: 'Use: import x from "..."',
    },
    {
      pattern: /import\s+.*\s+from\s+['"]http['"]/,
      check: 'node-http-import',
      message: 'Importing from "http" — Vajra uses Bun.serve',
      severity: 'warn',
    },
    {
      pattern: /import\s+.*\s+from\s+['"]express['"]/,
      check: 'express-import',
      message: 'Express import found — Vajra replaces Express',
      severity: 'error',
    },
    {
      pattern: /process\.env\.[A-Z_]+\s*(?!=)/,
      check: 'raw-process-env',
      message: 'Raw process.env usage — consider defineConfig() for typed env',
      severity: 'info',
    },
    {
      pattern: /console\.log\s*\(/,
      check: 'console-log',
      message: 'console.log usage — consider createLogger() for structured logs',
      severity: 'info',
    },
  ];

  const hits = new Map<string, number>();
  for (const file of files) {
    let content: string;
    try { content = await readFile(file, 'utf8'); } catch { continue; }
    for (const p of patterns) {
      if (p.pattern.test(content)) {
        hits.set(p.check, (hits.get(p.check) ?? 0) + 1);
      }
    }
  }

  for (const p of patterns) {
    const count = hits.get(p.check) ?? 0;
    if (count > 0) {
      findings.push({
        severity: p.severity,
        check: p.check,
        message: `${p.message} (${count} file${count > 1 ? 's' : ''})`,
        fix: p.fix,
      });
    }
  }
}

async function checkGitignore(cwd: string, findings: Finding[]): Promise<void> {
  try {
    const content = await readFile(join(cwd, '.gitignore'), 'utf8');
    const required = ['node_modules', '.env'];
    const missing = required.filter((r) => !new RegExp(`^${r}$`, 'm').test(content) && !content.includes(r + '\n'));
    if (missing.length > 0) {
      findings.push({
        severity: 'warn',
        check: 'gitignore',
        message: `.gitignore missing: ${missing.join(', ')}`,
        fix: `Add lines: ${missing.join(', ')}`,
      });
    } else {
      findings.push({ severity: 'info', check: 'gitignore', message: 'required entries present' });
    }
  } catch {
    findings.push({
      severity: 'warn',
      check: 'gitignore',
      message: '.gitignore missing',
      fix: 'Create .gitignore with node_modules, .env, dist, .DS_Store',
    });
  }
}

async function checkTestSetup(cwd: string, findings: Finding[]): Promise<void> {
  const testDirs = ['test', 'tests', '__tests__'];
  let hasTests = false;
  for (const dir of testDirs) {
    if (await fileExists(join(cwd, dir))) { hasTests = true; break; }
  }

  if (!hasTests) {
    // Check for co-located *.test.ts
    const files: string[] = [];
    try {
      await walkTs(join(cwd, 'src'), files);
      hasTests = files.some((f) => f.endsWith('.test.ts') || f.endsWith('.spec.ts'));
    } catch { /* ignore */ }
  }

  if (!hasTests) {
    findings.push({
      severity: 'info',
      check: 'tests',
      message: 'No test files found',
      fix: 'bun test is Bun-native — add *.test.ts files',
    });
  } else {
    findings.push({ severity: 'info', check: 'tests', message: 'test files present' });
  }
}

/* ═════════════ HELPERS ═════════════ */

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function walkTs(dir: string, out: string[]): Promise<void> {
  let entries: any[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      await walkTs(full, out);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full);
    }
  }
}
