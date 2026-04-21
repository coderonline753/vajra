import { describe, it, expect } from 'bun:test';
import { CircuitBreaker, CircuitOpenError } from '../../src/index';

describe('Circuit Breaker', () => {
  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.stats.state).toBe('CLOSED');
  });

  it('successful calls keep circuit CLOSED', async () => {
    const cb = new CircuitBreaker('test');

    for (let i = 0; i < 10; i++) {
      await cb.execute(() => Promise.resolve('ok'));
    }

    expect(cb.stats.state).toBe('CLOSED');
    expect(cb.stats.successes).toBe(10);
  });

  it('opens after failure threshold', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(() => Promise.reject(new Error('fail')));
      } catch { /* expected */ }
    }

    expect(cb.stats.state).toBe('OPEN');
    expect(cb.stats.failures).toBe(3);
  });

  it('OPEN circuit throws CircuitOpenError', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeout: 60000 });

    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch { /* trip it */ }

    try {
      await cb.execute(() => Promise.resolve('ok'));
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err instanceof CircuitOpenError).toBe(true);
      expect((err as CircuitOpenError).circuitName).toBe('test');
    }
  });

  it('transitions to HALF_OPEN after reset timeout', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeout: 50 });

    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch { /* trip it */ }

    expect(cb.stats.state).toBe('OPEN');

    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 60));

    // Next call should attempt HALF_OPEN
    const result = await cb.execute(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(cb.stats.state).toBe('CLOSED');
  });

  it('HALF_OPEN failure reopens circuit', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeout: 50 });

    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch { /* trip it */ }

    await new Promise(r => setTimeout(r, 60));

    // Fail during HALF_OPEN
    try {
      await cb.execute(() => Promise.reject(new Error('still broken')));
    } catch { /* expected */ }

    expect(cb.stats.state).toBe('OPEN');
  });

  it('timeout triggers failure', async () => {
    const cb = new CircuitBreaker('test', { timeout: 50, failureThreshold: 1 });

    try {
      await cb.execute(() => new Promise(r => setTimeout(r, 200)));
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain('timeout');
    }

    expect(cb.stats.state).toBe('OPEN');
  });

  it('onStateChange callback fires', async () => {
    const transitions: string[] = [];
    const cb = new CircuitBreaker('test', {
      failureThreshold: 1,
      resetTimeout: 50,
      onStateChange: (from, to) => transitions.push(`${from}->${to}`),
    });

    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch { /* expected */ }

    expect(transitions).toContain('CLOSED->OPEN');
  });

  it('reset() force-closes the circuit', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1 });

    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch { /* trip it */ }

    expect(cb.stats.state).toBe('OPEN');
    cb.reset();
    expect(cb.stats.state).toBe('CLOSED');

    const result = await cb.execute(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('custom isFailure filter', async () => {
    const cb = new CircuitBreaker('test', {
      failureThreshold: 1,
      isFailure: (err) => err.message !== 'expected',
    });

    // "expected" errors should not trip the circuit
    try {
      await cb.execute(() => Promise.reject(new Error('expected')));
    } catch { /* expected */ }

    expect(cb.stats.state).toBe('CLOSED');

    // Unexpected errors should trip it
    try {
      await cb.execute(() => Promise.reject(new Error('unexpected')));
    } catch { /* expected */ }

    expect(cb.stats.state).toBe('OPEN');
  });
});
