import { describe, it, expect } from 'bun:test';
import { Vajra, defineModule, ModuleRegistry } from '../../src/index';

describe('defineModule', () => {
  it('creates a module with routes and actions', () => {
    const mod = defineModule({
      name: 'users',
      routes: [
        { method: 'GET', path: '/', handler: (c) => c.json({ users: [] }) },
      ],
      actions: [
        { name: 'getUser', handler: async (input: any) => ({ id: input.id, name: 'Test' }) },
      ],
    });

    expect(mod.name).toBe('users');
    expect(mod.prefix).toBe('/users');
    expect(mod.routes).toHaveLength(1);
    expect(mod.actions.has('getUser')).toBe(true);
  });

  it('calls actions', async () => {
    const mod = defineModule({
      name: 'math',
      actions: [
        { name: 'add', handler: async (input: any) => input.a + input.b },
      ],
    });

    const result = await mod.call('add', { a: 2, b: 3 });
    expect(result).toBe(5);
  });

  it('throws on unknown action', async () => {
    const mod = defineModule({ name: 'test' });

    try {
      await mod.call('nonexistent', {});
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain('no action');
    }
  });

  it('init and destroy lifecycle', async () => {
    let initCalled = false;
    let destroyCalled = false;

    const mod = defineModule({
      name: 'lifecycle',
      onInit: () => { initCalled = true; },
      onDestroy: () => { destroyCalled = true; },
    });

    await mod.init();
    expect(initCalled).toBe(true);
    expect(mod.initialized).toBe(true);

    await mod.destroy();
    expect(destroyCalled).toBe(true);
    expect(mod.initialized).toBe(false);
  });

  it('init is idempotent', async () => {
    let count = 0;
    const mod = defineModule({
      name: 'idem',
      onInit: () => { count++; },
    });

    await mod.init();
    await mod.init();
    expect(count).toBe(1);
  });
});

describe('ModuleRegistry', () => {
  it('registers and retrieves modules', () => {
    const registry = new ModuleRegistry();
    const mod = defineModule({ name: 'users' });
    registry.register(mod);

    expect(registry.get('users')).toBe(mod);
    expect(registry.size).toBe(1);
    expect(registry.names).toContain('users');
  });

  it('throws on duplicate registration', () => {
    const registry = new ModuleRegistry();
    registry.register(defineModule({ name: 'test' }));

    expect(() => registry.register(defineModule({ name: 'test' }))).toThrow('already registered');
  });

  it('initializes modules in dependency order', async () => {
    const order: string[] = [];
    const registry = new ModuleRegistry();

    registry.register(defineModule({
      name: 'db',
      onInit: () => { order.push('db'); },
    }));

    registry.register(defineModule({
      name: 'users',
      dependencies: ['db'],
      onInit: () => { order.push('users'); },
    }));

    registry.register(defineModule({
      name: 'orders',
      dependencies: ['db', 'users'],
      onInit: () => { order.push('orders'); },
    }));

    await registry.initAll();
    expect(order).toEqual(['db', 'users', 'orders']);
  });

  it('detects circular dependencies', () => {
    const registry = new ModuleRegistry();

    registry.register(defineModule({ name: 'a', dependencies: ['b'] }));
    registry.register(defineModule({ name: 'b', dependencies: ['a'] }));

    expect(registry.initAll()).rejects.toThrow('Circular dependency');
  });

  it('calls actions across modules', async () => {
    const registry = new ModuleRegistry();
    registry.register(defineModule({
      name: 'math',
      actions: [{ name: 'double', handler: async (n: any) => n * 2 }],
    }));

    const result = await registry.call('math', 'double', 5);
    expect(result).toBe(10);
  });

  it('mounts routes on Vajra app', async () => {
    const registry = new ModuleRegistry();
    registry.register(defineModule({
      name: 'users',
      prefix: '/api/users',
      routes: [
        { method: 'GET', path: '/', handler: (c) => c.json({ users: ['Arjun'] }) },
        { method: 'GET', path: '/:id', handler: (c) => c.json({ id: c.param('id') }) },
      ],
    }));

    const app = new Vajra();
    registry.mountRoutes(app);

    const r1 = await app.handle(new Request('http://localhost/api/users/'));
    expect(r1.status).toBe(200);
    const d1 = await r1.json() as any;
    expect(d1.users).toContain('Arjun');

    const r2 = await app.handle(new Request('http://localhost/api/users/42'));
    const d2 = await r2.json() as any;
    expect(d2.id).toBe('42');
  });

  it('destroys modules in reverse dependency order', async () => {
    const order: string[] = [];
    const registry = new ModuleRegistry();

    registry.register(defineModule({ name: 'db', onDestroy: () => { order.push('db'); } }));
    registry.register(defineModule({ name: 'users', dependencies: ['db'], onDestroy: () => { order.push('users'); } }));

    await registry.initAll();
    await registry.destroyAll();

    expect(order).toEqual(['users', 'db']);
  });
});
