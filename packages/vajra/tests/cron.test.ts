import { describe, test, expect } from 'bun:test';
import { createScheduler } from '../src/cron';

describe('Cron Scheduler', () => {
  test('adds a job', () => {
    const scheduler = createScheduler();
    scheduler.add('test', '0 * * * *', () => {});
    const status = scheduler.status();
    expect(status).toHaveLength(1);
    expect(status[0].name).toBe('test');
    expect(status[0].runCount).toBe(0);
  });

  test('rejects duplicate job names', () => {
    const scheduler = createScheduler();
    scheduler.add('test', '0 * * * *', () => {});
    expect(() => scheduler.add('test', '0 * * * *', () => {})).toThrow('already exists');
  });

  test('removes a job', () => {
    const scheduler = createScheduler();
    scheduler.add('test', '0 * * * *', () => {});
    scheduler.remove('test');
    expect(scheduler.status()).toHaveLength(0);
  });

  test('runs a job manually', async () => {
    let ran = false;
    const scheduler = createScheduler();
    scheduler.add('test', '0 0 1 1 *', () => { ran = true; }); // Far future
    await scheduler.run('test');
    expect(ran).toBe(true);
    expect(scheduler.status()[0].runCount).toBe(1);
  });

  test('tracks errors', async () => {
    let errorJob = '';
    const scheduler = createScheduler({
      onError: (job) => { errorJob = job; },
    });
    scheduler.add('failing', '0 0 1 1 *', () => { throw new Error('boom'); });
    await scheduler.run('failing');
    expect(scheduler.status()[0].errors).toBe(1);
    expect(errorJob).toBe('failing');
  });

  test('tracks completion', async () => {
    let completedJob = '';
    const scheduler = createScheduler({
      onComplete: (job) => { completedJob = job; },
    });
    scheduler.add('success', '0 0 1 1 *', () => {});
    await scheduler.run('success');
    expect(completedJob).toBe('success');
  });

  test('handles @hourly shortcut', () => {
    const scheduler = createScheduler();
    scheduler.add('hourly', '@hourly', () => {});
    expect(scheduler.status()[0].expression).toBe('@hourly');
  });

  test('handles @daily shortcut', () => {
    const scheduler = createScheduler();
    scheduler.add('daily', '@daily', () => {});
    expect(scheduler.status()[0].nextRun).toBeTruthy();
  });

  test('handles @every interval', () => {
    const scheduler = createScheduler();
    scheduler.add('frequent', '@every_5s', () => {});
    expect(scheduler.status()[0].nextRun).toBeTruthy();
  });

  test('rejects invalid cron expression', () => {
    const scheduler = createScheduler();
    expect(() => scheduler.add('bad', 'invalid', () => {})).toThrow('Invalid cron');
  });

  test('start and stop', () => {
    const scheduler = createScheduler();
    scheduler.add('test', '@every_1s', () => {});
    scheduler.start();
    scheduler.stop();
    // No error = success
  });

  test('interval job runs on schedule', async () => {
    let count = 0;
    const scheduler = createScheduler();
    scheduler.add('counter', '@every_1s', () => { count++; });
    scheduler.start();

    // Wait for ~1.5 seconds
    await new Promise(r => setTimeout(r, 1500));
    scheduler.stop();

    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('async job handler works', async () => {
    let result = '';
    const scheduler = createScheduler();
    scheduler.add('async', '0 0 1 1 *', async () => {
      await new Promise(r => setTimeout(r, 10));
      result = 'done';
    });
    await scheduler.run('async');
    expect(result).toBe('done');
  });

  test('last run timestamp updates', async () => {
    const scheduler = createScheduler();
    scheduler.add('test', '0 0 1 1 *', () => {});
    expect(scheduler.status()[0].lastRun).toBeNull();
    await scheduler.run('test');
    expect(scheduler.status()[0].lastRun).toBeInstanceOf(Date);
  });
});
