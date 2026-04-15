import { describe, it, expect } from 'bun:test';
import { ServiceRegistry } from '../../src/index';

describe('ServiceRegistry', () => {
  it('registers and retrieves services', () => {
    const registry = new ServiceRegistry();
    const instance = registry.register('api', 'localhost', 3000);

    expect(instance.name).toBe('api');
    expect(instance.host).toBe('localhost');
    expect(instance.port).toBe(3000);
    expect(instance.status).toBe('healthy');

    const instances = registry.getInstances('api');
    expect(instances).toHaveLength(1);
  });

  it('deregisters services', () => {
    const registry = new ServiceRegistry();
    const instance = registry.register('api', 'localhost', 3000);

    expect(registry.deregister('api', instance.id)).toBe(true);
    expect(registry.getInstances('api')).toHaveLength(0);
  });

  it('heartbeat updates lastHeartbeat', () => {
    const registry = new ServiceRegistry();
    const instance = registry.register('api', 'localhost', 3000);
    const originalHb = instance.lastHeartbeat;

    registry.heartbeat('api', instance.id);
    const updated = registry.getInstances('api')[0];
    expect(updated.lastHeartbeat).toBeGreaterThanOrEqual(originalHb);
  });

  it('round-robin load balancing', () => {
    const registry = new ServiceRegistry();
    registry.register('api', 'host1', 3000);
    registry.register('api', 'host2', 3001);
    registry.register('api', 'host3', 3002);

    const hosts = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const inst = registry.getInstance('api');
      if (inst) hosts.add(inst.host);
    }

    expect(hosts.size).toBe(3);
  });

  it('returns null for unknown service', () => {
    const registry = new ServiceRegistry();
    expect(registry.getInstance('nonexistent')).toBeNull();
  });

  it('multiple services tracked independently', () => {
    const registry = new ServiceRegistry();
    registry.register('api', 'localhost', 3000);
    registry.register('api', 'localhost', 3001);
    registry.register('db', 'localhost', 5432);

    expect(registry.getInstances('api')).toHaveLength(2);
    expect(registry.getInstances('db')).toHaveLength(1);
    expect(registry.serviceNames).toContain('api');
    expect(registry.serviceNames).toContain('db');
    expect(registry.totalInstances).toBe(3);
  });

  it('onRegister callback fires', () => {
    let registered: any = null;
    const registry = new ServiceRegistry({
      onRegister: (inst) => { registered = inst; },
    });

    registry.register('api', 'localhost', 3000);
    expect(registered).not.toBeNull();
    expect(registered.name).toBe('api');
  });

  it('clear removes all services', () => {
    const registry = new ServiceRegistry();
    registry.register('api', 'localhost', 3000);
    registry.register('db', 'localhost', 5432);

    registry.clear();
    expect(registry.totalInstances).toBe(0);
    expect(registry.serviceNames).toHaveLength(0);
  });

  it('metadata is preserved', () => {
    const registry = new ServiceRegistry();
    const instance = registry.register('api', 'localhost', 3000, { version: '1.2.3', env: 'prod' });

    expect(instance.metadata?.version).toBe('1.2.3');
    expect(instance.metadata?.env).toBe('prod');
  });
});
