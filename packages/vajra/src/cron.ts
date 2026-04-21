/**
 * Vajra Cron / Task Scheduler
 * Built-in job scheduling with cron expressions.
 * No external dependency (node-cron, etc.)
 *
 * @example
 *   const scheduler = createScheduler();
 *   scheduler.add('cleanup', '0 3 * * *', async () => { await db.cleanup(); });
 *   scheduler.start();
 */

/* ═══════ TYPES ═══════ */

interface CronJob {
  name: string;
  expression: string;
  handler: () => void | Promise<void>;
  running: boolean;
  lastRun: Date | null;
  nextRun: Date | null;
  runCount: number;
  errors: number;
}

interface SchedulerOptions {
  /** Timezone offset in hours (default: 0 = UTC) */
  timezone?: number;
  /** Error handler */
  onError?: (job: string, error: Error) => void;
  /** Run handler when job completes */
  onComplete?: (job: string, durationMs: number) => void;
}

/* ═══════ CRON PARSER ═══════ */

/**
 * Parse a cron expression into its components.
 * Supports: * (any), ranges (1-5), lists (1,3,5), steps (asterisk/5)
 * Format: minute hour day month weekday
 *
 * Special strings: @yearly, @monthly, @weekly, @daily, @hourly, @every_Ns, @every_Nm, @every_Nh
 */
function parseCronExpression(expr: string): { minutes: Set<number>; hours: Set<number>; days: Set<number>; months: Set<number>; weekdays: Set<number> } | { intervalMs: number } {
  // Handle @every shortcuts
  const everyMatch = expr.match(/^@every[_\s](\d+)([smh])$/);
  if (everyMatch) {
    const value = parseInt(everyMatch[1]);
    const unit = everyMatch[2];
    const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000 };
    return { intervalMs: value * multipliers[unit] };
  }

  // Handle named shortcuts
  const shortcuts: Record<string, string> = {
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
    '@monthly': '0 0 1 * *',
    '@weekly': '0 0 * * 0',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@hourly': '0 * * * *',
  };

  const cronStr = shortcuts[expr] || expr;
  const parts = cronStr.trim().split(/\s+/);

  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: "${expr}". Expected 5 fields (minute hour day month weekday)`);
  }

  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    days: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    weekdays: parseField(parts[4], 0, 6),
  };
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr);
      const start = range === '*' ? min : parseInt(range);
      for (let i = start; i <= max; i += step) values.add(i);
    } else if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr);
      const end = parseInt(endStr);
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      values.add(parseInt(part));
    }
  }

  return values;
}

function matchesCron(parsed: ReturnType<typeof parseCronExpression>, date: Date): boolean {
  if ('intervalMs' in parsed) return false; // Interval-based, not cron-based

  return parsed.minutes.has(date.getMinutes())
    && parsed.hours.has(date.getHours())
    && parsed.days.has(date.getDate())
    && parsed.months.has(date.getMonth() + 1)
    && parsed.weekdays.has(date.getDay());
}

function getNextRun(parsed: ReturnType<typeof parseCronExpression>, from: Date): Date {
  if ('intervalMs' in parsed) {
    return new Date(from.getTime() + parsed.intervalMs);
  }

  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  // Brute force next match (max 2 years ahead)
  const limit = 365 * 2 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matchesCron(parsed, next)) return next;
    next.setMinutes(next.getMinutes() + 1);
  }

  return next;
}

/* ═══════ SCHEDULER ═══════ */

class Scheduler {
  private jobs = new Map<string, CronJob & { parsed: ReturnType<typeof parseCronExpression>; timer?: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> }>();
  private running = false;
  private mainTimer: ReturnType<typeof setInterval> | null = null;
  private options: SchedulerOptions;

  constructor(options: SchedulerOptions = {}) {
    this.options = options;
  }

  /** Add a cron job */
  add(name: string, expression: string, handler: () => void | Promise<void>): this {
    if (this.jobs.has(name)) {
      throw new Error(`[Vajra Cron] Job "${name}" already exists`);
    }

    const parsed = parseCronExpression(expression);

    this.jobs.set(name, {
      name,
      expression,
      handler,
      running: false,
      lastRun: null,
      nextRun: getNextRun(parsed, new Date()),
      runCount: 0,
      errors: 0,
      parsed,
    });

    // If scheduler already running and this is an interval job, start it immediately
    if (this.running && 'intervalMs' in parsed) {
      this.startIntervalJob(name);
    }

    return this;
  }

  /** Remove a job */
  remove(name: string): this {
    const job = this.jobs.get(name);
    if (job?.timer) {
      clearInterval(job.timer);
      clearTimeout(job.timer);
    }
    this.jobs.delete(name);
    return this;
  }

  /** Start the scheduler */
  start(): this {
    if (this.running) return this;
    this.running = true;

    // Start interval-based jobs
    for (const [name, job] of this.jobs) {
      if ('intervalMs' in job.parsed) {
        this.startIntervalJob(name);
      }
    }

    // Check cron jobs every 30 seconds
    this.mainTimer = setInterval(() => {
      const now = new Date();
      for (const [name, job] of this.jobs) {
        if ('intervalMs' in job.parsed) continue; // Handled by interval timer
        if (job.running) continue; // Skip if still running

        if (matchesCron(job.parsed, now)) {
          this.executeJob(name);
        }
      }
    }, 30_000);

    if (this.mainTimer.unref) this.mainTimer.unref();

    return this;
  }

  /** Stop the scheduler */
  stop(): void {
    this.running = false;
    if (this.mainTimer) clearInterval(this.mainTimer);
    for (const job of this.jobs.values()) {
      if (job.timer) {
        clearInterval(job.timer);
        clearTimeout(job.timer);
      }
    }
  }

  /** Get job status */
  status(): Array<{ name: string; expression: string; lastRun: Date | null; nextRun: Date | null; runCount: number; errors: number; running: boolean }> {
    return [...this.jobs.values()].map(j => ({
      name: j.name,
      expression: j.expression,
      lastRun: j.lastRun,
      nextRun: j.nextRun,
      runCount: j.runCount,
      errors: j.errors,
      running: j.running,
    }));
  }

  /** Run a job manually */
  async run(name: string): Promise<void> {
    await this.executeJob(name);
  }

  private startIntervalJob(name: string): void {
    const job = this.jobs.get(name);
    if (!job || !('intervalMs' in job.parsed)) return;

    job.timer = setInterval(() => {
      if (!job.running) this.executeJob(name);
    }, job.parsed.intervalMs);

    if ((job.timer as any).unref) (job.timer as any).unref();
  }

  private async executeJob(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) return;

    job.running = true;
    const start = performance.now();

    try {
      await job.handler();
      job.runCount++;
      job.lastRun = new Date();
      job.nextRun = getNextRun(job.parsed, new Date());

      const duration = performance.now() - start;
      this.options.onComplete?.(name, duration);
    } catch (err: any) {
      job.errors++;
      this.options.onError?.(name, err);
    } finally {
      job.running = false;
    }
  }
}

/* ═══════ PUBLIC API ═══════ */

/**
 * Create a task scheduler.
 *
 * @example
 *   const scheduler = createScheduler({
 *     onError: (job, err) => console.error(`Job ${job} failed:`, err),
 *   });
 *
 *   // Cron expression
 *   scheduler.add('daily-cleanup', '0 3 * * *', async () => {
 *     await db.deleteStaleSessions();
 *   });
 *
 *   // Named shortcuts
 *   scheduler.add('hourly-sync', '@hourly', syncData);
 *
 *   // Interval-based
 *   scheduler.add('health-check', '@every_30s', checkHealth);
 *   scheduler.add('metrics', '@every_5m', collectMetrics);
 *
 *   scheduler.start();
 */
export function createScheduler(options?: SchedulerOptions): Scheduler {
  return new Scheduler(options);
}

export type { CronJob, SchedulerOptions };
