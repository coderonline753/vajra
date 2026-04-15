/**
 * Vajra Event Bus
 * In-memory event bus for dev. Pluggable transport for production (Redis/NATS/Kafka).
 */

export type EventHandler<T = unknown> = (payload: T, metadata: EventMetadata) => Promise<void> | void;

export interface EventMetadata {
  eventId: string;
  timestamp: number;
  source: string;
  correlationId?: string;
}

interface Subscription {
  event: string;
  handler: EventHandler;
  once: boolean;
}

export interface EventTransport {
  publish(event: string, payload: unknown, metadata: EventMetadata): Promise<void>;
  subscribe(event: string, handler: EventHandler): Promise<() => void>;
}

/** Generate unique event ID */
function generateEventId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

export class EventBus {
  private subscriptions = new Map<string, Subscription[]>();
  private transport: EventTransport | null = null;
  private history: { event: string; payload: unknown; metadata: EventMetadata }[] = [];
  private maxHistory: number;

  constructor(options?: { transport?: EventTransport; maxHistory?: number }) {
    this.transport = options?.transport ?? null;
    this.maxHistory = options?.maxHistory ?? 1000;
  }

  /** Subscribe to an event */
  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    const sub: Subscription = { event, handler: handler as EventHandler, once: false };
    const subs = this.subscriptions.get(event) ?? [];
    subs.push(sub);
    this.subscriptions.set(event, subs);

    // Return unsubscribe function
    return () => {
      const list = this.subscriptions.get(event);
      if (list) {
        const idx = list.indexOf(sub);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }

  /** Subscribe to an event (fires once then auto-unsubscribes) */
  once<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    const sub: Subscription = { event, handler: handler as EventHandler, once: true };
    const subs = this.subscriptions.get(event) ?? [];
    subs.push(sub);
    this.subscriptions.set(event, subs);

    return () => {
      const list = this.subscriptions.get(event);
      if (list) {
        const idx = list.indexOf(sub);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }

  /** Publish an event */
  async emit<T = unknown>(event: string, payload: T, source = 'local'): Promise<void> {
    const metadata: EventMetadata = {
      eventId: generateEventId(),
      timestamp: Date.now(),
      source,
    };

    // Store in history
    this.history.push({ event, payload, metadata });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // External transport
    if (this.transport) {
      await this.transport.publish(event, payload, metadata);
    }

    // Local handlers
    const subs = this.subscriptions.get(event);
    if (!subs || subs.length === 0) return;

    const toRemove: number[] = [];

    for (let i = 0; i < subs.length; i++) {
      try {
        await subs[i].handler(payload, metadata);
      } catch (err) {
        console.error(`[EventBus] Error in handler for '${event}':`, err);
      }

      if (subs[i].once) {
        toRemove.push(i);
      }
    }

    // Remove once-handlers in reverse order
    for (let i = toRemove.length - 1; i >= 0; i--) {
      subs.splice(toRemove[i], 1);
    }
  }

  /** Get event history */
  getHistory(event?: string): typeof this.history {
    if (event) {
      return this.history.filter(h => h.event === event);
    }
    return [...this.history];
  }

  /** Clear all subscriptions */
  clear(): void {
    this.subscriptions.clear();
  }

  /** Clear history */
  clearHistory(): void {
    this.history = [];
  }

  /** Get subscriber count for an event */
  listenerCount(event: string): number {
    return this.subscriptions.get(event)?.length ?? 0;
  }

  /** Get all event names with subscribers */
  get events(): string[] {
    return [...this.subscriptions.keys()].filter(e => (this.subscriptions.get(e)?.length ?? 0) > 0);
  }
}
