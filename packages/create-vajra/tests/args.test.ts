import { describe, it, expect } from 'bun:test';
import { parseArgs } from '../src/args';

describe('Argument Parser', () => {
  it('parses command', () => {
    const args = parseArgs(['new', 'my-app']);
    expect(args.command).toBe('new');
    expect(args.positionals).toEqual(['my-app']);
  });

  it('parses flags', () => {
    const args = parseArgs(['new', 'app', '--template', 'full']);
    expect(args.command).toBe('new');
    expect(args.flags.template).toBe('full');
  });

  it('parses boolean flags', () => {
    const args = parseArgs(['--version']);
    expect(args.flags.version).toBe(true);
  });

  it('parses short flags', () => {
    const args = parseArgs(['-v']);
    expect(args.flags.v).toBe(true);
  });

  it('parses equals-style flags', () => {
    const args = parseArgs(['dev', '--port=4000']);
    expect(args.command).toBe('dev');
    expect(args.flags.port).toBe('4000');
  });

  it('handles no arguments', () => {
    const args = parseArgs([]);
    expect(args.command).toBe('');
    expect(args.positionals).toEqual([]);
  });

  it('handles multiple positionals', () => {
    const args = parseArgs(['generate', 'module', 'users']);
    expect(args.command).toBe('generate');
    expect(args.positionals).toEqual(['module', 'users']);
  });
});
