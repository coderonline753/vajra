import { describe, it, expect } from 'bun:test';
import { EventBus } from '../../src/index';

describe('EventBus', () => {
  it('subscribes and emits events', async () => {
    const bus = new EventBus();
    let received: any = null;

    bus.on('user.created', (payload) => { received = payload; });
    await bus.emit('user.created', { id: 1, name: 'Arjun' });

    expect(received).toEqual({ id: 1, name: 'Arjun' });
  });

  it('multiple subscribers all receive event', async () => {
    const bus = new EventBus();
    const results: number[] = [];

    bus.on('test', () => { results.push(1); });
    bus.on('test', () => { results.push(2); });
    bus.on('test', () => { results.push(3); });

    await bus.emit('test', null);
    expect(results).toEqual([1, 2, 3]);
  });

  it('once handler fires only once', async () => {
    const bus = new EventBus();
    let count = 0;

    bus.once('ping', () => { count++; });
    await bus.emit('ping', null);
    await bus.emit('ping', null);

    expect(count).toBe(1);
  });

  it('unsubscribe stops receiving events', async () => {
    const bus = new EventBus();
    let count = 0;

    const unsub = bus.on('test', () => { count++; });
    await bus.emit('test', null);
    unsub();
    await bus.emit('test', null);

    expect(count).toBe(1);
  });

  it('event metadata includes eventId and timestamp', async () => {
    const bus = new EventBus();
    let meta: any = null;

    bus.on('test', (_, metadata) => { meta = metadata; });
    await bus.emit('test', null, 'my-service');

    expect(meta.eventId).toBeTruthy();
    expect(meta.timestamp).toBeGreaterThan(0);
    expect(meta.source).toBe('my-service');
  });

  it('stores event history', async () => {
    const bus = new EventBus();
    await bus.emit('a', { x: 1 });
    await bus.emit('b', { x: 2 });
    await bus.emit('a', { x: 3 });

    const all = bus.getHistory();
    expect(all).toHaveLength(3);

    const aOnly = bus.getHistory('a');
    expect(aOnly).toHaveLength(2);
  });

  it('limits history size', async () => {
    const bus = new EventBus({ maxHistory: 5 });

    for (let i = 0; i < 10; i++) {
      await bus.emit('test', { i });
    }

    expect(bus.getHistory()).toHaveLength(5);
  });

  it('handler errors do not crash bus', async () => {
    const bus = new EventBus();
    let secondRan = false;

    bus.on('test', () => { throw new Error('boom'); });
    bus.on('test', () => { secondRan = true; });

    await bus.emit('test', null);
    expect(secondRan).toBe(true);
  });

  it('listenerCount and events', () => {
    const bus = new EventBus();
    bus.on('a', () => {});
    bus.on('a', () => {});
    bus.on('b', () => {});

    expect(bus.listenerCount('a')).toBe(2);
    expect(bus.listenerCount('b')).toBe(1);
    expect(bus.listenerCount('c')).toBe(0);
    expect(bus.events).toContain('a');
    expect(bus.events).toContain('b');
  });

  it('clear removes all subscriptions', () => {
    const bus = new EventBus();
    bus.on('a', () => {});
    bus.on('b', () => {});
    bus.clear();

    expect(bus.listenerCount('a')).toBe(0);
    expect(bus.events).toHaveLength(0);
  });
});
