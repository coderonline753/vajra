/**
 * Vajra Queue Module
 * Job queue with retry, delayed jobs, concurrency control.
 * Memory store (default) or bring-your-own Redis store for distributed work.
 *
 * const queue = createQueue<EmailData>('emails', {
 *   concurrency: 5,
 *   retries: 3,
 *   backoff: { type: 'exponential', delay: 1000 },
 * });
 *
 * queue.process(async (job) => {
 *   await sendEmail(job.data);
 * });
 *
 * await queue.add({ to: 'x@y.z' }, { delay: 5000 });
 */

/* ═════════════ TYPES ═════════════ */

export interface BackoffConfig {
  type: 'fixed' | 'exponential';
  /** Base delay in ms */
  delay: number;
  /** Cap for exponential backoff (ms). Default: 60000 */
  max?: number;
}

export interface JobOptions {
  /** Delay execution by N milliseconds */
  delay?: number;
  /** Max retry attempts on failure */
  retries?: number;
  /** Backoff strategy */
  backoff?: BackoffConfig;
  /** Priority: lower numbers run first. Default: 0 */
  priority?: number;
}

export interface Job<T = unknown> {
  id: string;
  data: T;
  attempts: number;
  maxRetries: number;
  backoff: BackoffConfig;
  priority: number;
  createdAt: number;
  runAt: number;
  lastError: string | null;
  state: 'waiting' | 'active' | 'delayed' | 'completed' | 'failed';
}

export interface QueueOptions {
  /** Max concurrent workers. Default: 1 */
  concurrency?: number;
  /** Default retry count for jobs. Default: 0 */
  retries?: number;
  /** Default backoff. Default: exponential 1000ms */
  backoff?: BackoffConfig;
  /** Optional distributed store (Redis etc.). Default: in-memory */
  store?: QueueStore;
  /** Auto-start processing. Default: true */
  autoStart?: boolean;
  /** Polling interval for delayed jobs (ms). Default: 250 */
  pollInterval?: number;
}

export interface QueueStore {
  push(queueName: string, job: Job): Promise<void>;
  popReady(queueName: string, now: number): Promise<Job | null>;
  update(queueName: string, job: Job): Promise<void>;
  size(queueName: string): Promise<number>;
  clear(queueName: string): Promise<void>;
}

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void> | void;

export type QueueEvent =
  | { type: 'completed'; job: Job }
  | { type: 'failed'; job: Job; error: Error }
  | { type: 'retrying'; job: Job; error: Error; nextRunIn: number }
  | { type: 'stalled'; job: Job };

export type QueueListener = (event: QueueEvent) => void;

/* ═════════════ ID GENERATOR ═════════════ */

let idCounter = 0;
function generateId(): string {
  idCounter = (idCounter + 1) & 0xffffff;
  return `${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ═════════════ BACKOFF CALCULATION ═════════════ */

export function computeBackoff(attempt: number, config: BackoffConfig): number {
  if (config.type === 'fixed') return config.delay;
  const exp = config.delay * Math.pow(2, Math.max(0, attempt - 1));
  const capped = config.max ? Math.min(exp, config.max) : exp;
  // Add ±20% jitter to prevent thundering herd
  const jitter = capped * 0.2 * (Math.random() - 0.5) * 2;
  return Math.max(0, Math.floor(capped + jitter));
}

/* ═════════════ MEMORY STORE (DEFAULT) ═════════════ */

export function createMemoryStore(): QueueStore {
  const queues = new Map<string, Job[]>();

  const get = (name: string): Job[] => {
    let q = queues.get(name);
    if (!q) { q = []; queues.set(name, q); }
    return q;
  };

  return {
    async push(name: string, job: Job) {
      const q = get(name);
      q.push(job);
      // Priority sort (lower first), then runAt
      q.sort((a, b) => a.priority - b.priority || a.runAt - b.runAt);
    },
    async popReady(name: string, now: number) {
      const q = get(name);
      for (let i = 0; i < q.length; i++) {
        const job = q[i]!;
        if (job.runAt <= now && (job.state === 'waiting' || job.state === 'delayed')) {
          job.state = 'active';
          q.splice(i, 1);
          return job;
        }
      }
      return null;
    },
    async update(name: string, job: Job) {
      const q = get(name);
      // Re-insert in priority order
      q.push(job);
      q.sort((a, b) => a.priority - b.priority || a.runAt - b.runAt);
    },
    async size(name: string) {
      return get(name).length;
    },
    async clear(name: string) {
      queues.set(name, []);
    },
  };
}

/* ═════════════ REDIS STORE HELPER ═════════════ */

export interface RedisQueueClient {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string, limit?: { offset: number; count: number }): Promise<string[]>;
  zrem(key: string, member: string): Promise<unknown>;
  zcard(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
}

/**
 * Redis-backed distributed queue store.
 * Jobs serialized as JSON and ranked by runAt timestamp in a sorted set.
 */
export function createRedisStore(client: RedisQueueClient, keyPrefix = 'vajra:q:'): QueueStore {
  const keyOf = (name: string) => `${keyPrefix}${name}`;

  return {
    async push(name: string, job: Job) {
      await client.zadd(keyOf(name), job.runAt, JSON.stringify(job));
    },
    async popReady(name: string, now: number) {
      const key = keyOf(name);
      const results = await client.zrangebyscore(key, '-inf', now, { offset: 0, count: 1 });
      if (!results.length) return null;
      const raw = results[0]!;
      await client.zrem(key, raw);
      const job: Job = JSON.parse(raw);
      job.state = 'active';
      return job;
    },
    async update(name: string, job: Job) {
      await client.zadd(keyOf(name), job.runAt, JSON.stringify(job));
    },
    async size(name: string) {
      return await client.zcard(keyOf(name));
    },
    async clear(name: string) {
      await client.del(keyOf(name));
    },
  };
}

/* ═════════════ QUEUE CLASS ═════════════ */

export class Queue<T = unknown> {
  readonly name: string;
  private options: Required<Pick<QueueOptions, 'concurrency' | 'retries' | 'backoff' | 'pollInterval'>>;
  private store: QueueStore;
  private handler: JobHandler<T> | null = null;
  private running = false;
  private activeCount = 0;
  private listeners: QueueListener[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private autoStarted = false;
  private shouldAutoStart: boolean;

  constructor(name: string, options: QueueOptions = {}) {
    this.name = name;
    this.options = {
      concurrency: options.concurrency ?? 1,
      retries: options.retries ?? 0,
      backoff: options.backoff ?? { type: 'exponential', delay: 1000, max: 60000 },
      pollInterval: options.pollInterval ?? 250,
    };
    this.store = options.store ?? createMemoryStore();
    this.shouldAutoStart = options.autoStart !== false;
  }

  /** Add a job to the queue */
  async add(data: T, opts: JobOptions = {}): Promise<Job<T>> {
    const now = Date.now();
    const job: Job<T> = {
      id: generateId(),
      data,
      attempts: 0,
      maxRetries: opts.retries ?? this.options.retries,
      backoff: opts.backoff ?? this.options.backoff,
      priority: opts.priority ?? 0,
      createdAt: now,
      runAt: now + (opts.delay ?? 0),
      lastError: null,
      state: (opts.delay ?? 0) > 0 ? 'delayed' : 'waiting',
    };
    await this.store.push(this.name, job as Job);
    if (this.shouldAutoStart && !this.autoStarted && this.handler) {
      this.start();
    }
    return job;
  }

  /** Register the job handler and start processing */
  process(handler: JobHandler<T>): void {
    if (this.handler) {
      throw new Error(`Queue "${this.name}" already has a processor`);
    }
    this.handler = handler;
    if (this.shouldAutoStart) {
      this.start();
    }
  }

  /** Start worker loop (called automatically if autoStart=true) */
  start(): void {
    if (this.running) return;
    if (!this.handler) {
      throw new Error(`Cannot start queue "${this.name}" without a processor`);
    }
    this.running = true;
    this.autoStarted = true;
    this.poll();
  }

  /** Stop worker loop. Waits for in-flight jobs to finish. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    // Wait for active jobs to drain
    while (this.activeCount > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Subscribe to queue events */
  on(listener: QueueListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Current queue size (waiting + delayed jobs) */
  async size(): Promise<number> {
    return await this.store.size(this.name);
  }

  /** Count of active workers currently processing */
  get active(): number {
    return this.activeCount;
  }

  /** Clear all jobs (destructive) */
  async clear(): Promise<void> {
    await this.store.clear(this.name);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    while (this.running && this.activeCount < this.options.concurrency) {
      const job = await this.store.popReady(this.name, Date.now());
      if (!job) break;
      this.activeCount++;
      this.runJob(job as Job<T>).finally(() => {
        this.activeCount--;
        if (this.running) this.poll();
      });
    }

    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), this.options.pollInterval);
    }
  }

  private async runJob(job: Job<T>): Promise<void> {
    job.attempts++;
    try {
      await this.handler!(job);
      job.state = 'completed';
      this.emit({ type: 'completed', job: job as Job });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      job.lastError = error.message;

      if (job.attempts <= job.maxRetries) {
        const delay = computeBackoff(job.attempts, job.backoff);
        job.runAt = Date.now() + delay;
        job.state = 'delayed';
        await this.store.update(this.name, job as Job);
        this.emit({ type: 'retrying', job: job as Job, error, nextRunIn: delay });
      } else {
        job.state = 'failed';
        this.emit({ type: 'failed', job: job as Job, error });
      }
    }
  }

  private emit(event: QueueEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* isolate listener errors */ }
    }
  }
}

/* ═════════════ FACTORY ═════════════ */

export function createQueue<T = unknown>(name: string, options?: QueueOptions): Queue<T> {
  return new Queue<T>(name, options);
}
