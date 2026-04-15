import { describe, it, expect } from 'bun:test';
import { Saga } from '../../src/index';

describe('Saga', () => {
  it('executes all steps successfully', async () => {
    const saga = new Saga<{ amount: number; charged: boolean; shipped: boolean }>('order');

    saga
      .step('charge',
        async (ctx) => ({ ...ctx, charged: true }),
        async () => { /* refund */ }
      )
      .step('ship',
        async (ctx) => ({ ...ctx, shipped: true }),
        async () => { /* cancel shipment */ }
      );

    const result = await saga.run({ amount: 100, charged: false, shipped: false });

    expect(result.status).toBe('completed');
    expect(result.context.charged).toBe(true);
    expect(result.context.shipped).toBe(true);
    expect(result.completedSteps).toEqual(['charge', 'ship']);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('compensates on failure', async () => {
    const compensated: string[] = [];

    const saga = new Saga<{ step1: boolean; step2: boolean }>('test');

    saga
      .step('step1',
        async (ctx) => ({ ...ctx, step1: true }),
        async () => { compensated.push('step1'); }
      )
      .step('step2',
        async () => { throw new Error('step2 failed'); },
        async () => { compensated.push('step2'); }
      );

    const result = await saga.run({ step1: false, step2: false });

    expect(result.status).toBe('compensated');
    expect(result.failedStep).toBe('step2');
    expect(result.error).toBe('step2 failed');
    expect(result.compensatedSteps).toEqual(['step1']);
    expect(compensated).toEqual(['step1']);
  });

  it('compensates in reverse order', async () => {
    const order: string[] = [];

    const saga = new Saga<Record<string, unknown>>('reverse');

    saga
      .step('a', async (ctx) => ctx, async () => { order.push('a'); })
      .step('b', async (ctx) => ctx, async () => { order.push('b'); })
      .step('c', async (ctx) => ctx, async () => { order.push('c'); })
      .step('d', async () => { throw new Error('fail'); }, async () => {});

    await saga.run({});
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('handles compensation failure gracefully', async () => {
    const saga = new Saga<Record<string, unknown>>('comp-fail');

    saga
      .step('a',
        async (ctx) => ctx,
        async () => { throw new Error('compensation crashed'); }
      )
      .step('b',
        async () => { throw new Error('step failed'); },
        async () => {}
      );

    // Should not throw despite compensation failure
    const result = await saga.run({});
    expect(result.status).toBe('compensated');
  });

  it('callbacks fire on step events', async () => {
    const events: string[] = [];

    const saga = new Saga<Record<string, unknown>>('callbacks', {
      onStepComplete: (step) => events.push(`done:${step}`),
      onStepFailed: (step) => events.push(`fail:${step}`),
      onCompensate: (step) => events.push(`comp:${step}`),
    });

    saga
      .step('a', async (ctx) => ctx, async () => {})
      .step('b', async () => { throw new Error('fail'); }, async () => {});

    await saga.run({});
    expect(events).toContain('done:a');
    expect(events).toContain('fail:b');
    expect(events).toContain('comp:a');
  });

  it('context flows through steps', async () => {
    const saga = new Saga<{ items: string[] }>('chain');

    saga
      .step('add-a', async (ctx) => ({ items: [...ctx.items, 'a'] }), async () => {})
      .step('add-b', async (ctx) => ({ items: [...ctx.items, 'b'] }), async () => {})
      .step('add-c', async (ctx) => ({ items: [...ctx.items, 'c'] }), async () => {});

    const result = await saga.run({ items: [] });
    expect(result.context.items).toEqual(['a', 'b', 'c']);
  });
});
