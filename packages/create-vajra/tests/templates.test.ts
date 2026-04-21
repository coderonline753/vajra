import { describe, it, expect } from 'bun:test';
import { getTemplate } from '../src/templates/index';

describe('Templates', () => {
  it('minimal template has required files', () => {
    const files = getTemplate('minimal', 'test-app');
    expect(files['package.json']).toBeTruthy();
    expect(files['tsconfig.json']).toBeTruthy();
    expect(files['src/index.ts']).toBeTruthy();
    expect(files['.gitignore']).toBeTruthy();
  });

  it('minimal template uses project name', () => {
    const files = getTemplate('minimal', 'my-api');
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.name).toBe('my-api');
    expect(files['src/index.ts']).toContain('my-api');
  });

  it('minimal template has vajra dependency', () => {
    const files = getTemplate('minimal', 'test');
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.dependencies.vajrajs).toBeTruthy();
  });

  it('full template has routes and tests', () => {
    const files = getTemplate('full', 'test-app');
    expect(files['src/routes/users.ts']).toBeTruthy();
    expect(files['src/routes/users.test.ts']).toBeTruthy();
    expect(files['.env.example']).toBeTruthy();
  });

  it('full template has zod dependency', () => {
    const files = getTemplate('full', 'test');
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.dependencies.zod).toBeTruthy();
  });

  it('full template has health routes', () => {
    const files = getTemplate('full', 'test');
    expect(files['src/index.ts']).toContain('registerHealthRoutes');
  });

  it('full template has compile build script', () => {
    const files = getTemplate('full', 'test');
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.scripts.build).toContain('--compile');
  });
});
