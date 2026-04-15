/**
 * Vajra Circuit Breaker
 * Prevents cascading failures for external service calls.
 * States: CLOSED (normal) → OPEN (failing) → HALF_OPEN (testing recovery)
 */

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeout?: number;
  halfOpenMax?: number;
  timeout?: number;
  onStateChange?: (from: CircuitState, to: CircuitState, name: string) => void;
  isFailure?: (error: Error) => boolean;
}

interface CircuitStats {
  state: CircuitState;
  failures: number;
  successes: number;
  totalRequests: number;
  lastFailure: number | null;
  lastSuccess: number | null;
}

export class CircuitBreaker {
  readonly name: string;
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private totalRequests = 0;
  private halfOpenAttempts = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private nextRetryTime = 0;

  private failureThreshold: number;
  private resetTimeout: number;
  private halfOpenMax: number;
  private timeout: number;
  private onStateChange?: (from: CircuitState, to: CircuitState, name: string) => void;
  private isFailure: (error: Error) => boolean;

  constructor(name: string, options: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeout = options.resetTimeout ?? 30_000;
    this.halfOpenMax = options.halfOpenMax ?? 1;
    this.timeout = options.timeout ?? 3_000;
    this.onStateChange = options.onStateChange;
    this.isFailure = options.isFailure ?? (() => true);
  }

  private transition(to: CircuitState): void {
    if (this.state !== to) {
      const from = this.state;
      this.state = to;
      this.onStateChange?.(from, to, this.name);
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalRequests++;

    if (this.state === 'OPEN') {
      if (Date.now() < this.nextRetryTime) {
        throw new CircuitOpenError(this.name, this.nextRetryTime - Date.now());
      }
      // Try half-open
      this.transition('HALF_OPEN');
      this.halfOpenAttempts = 0;
    }

    if (this.state === 'HALF_OPEN' && this.halfOpenAttempts >= this.halfOpenMax) {
      throw new CircuitOpenError(this.name, this.resetTimeout);
    }

    if (this.state === 'HALF_OPEN') {
      this.halfOpenAttempts++;
    }

    try {
      const result = await this.executeWithTimeout(fn);
      this.onSuccess();
      return result;
    } catch (error) {
      if (error instanceof CircuitOpenError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      if (this.isFailure(err)) {
        this.onFailure();
      }
      throw error;
    }
  }

  private async executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    if (this.timeout <= 0) return fn();

    return Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Circuit breaker timeout: ${this.name} (${this.timeout}ms)`)), this.timeout)
      ),
    ]);
  }

  private onSuccess(): void {
    this.successes++;
    this.lastSuccessTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.failures = 0;
      this.transition('CLOSED');
    }

    if (this.state === 'CLOSED') {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.transition('OPEN');
      this.nextRetryTime = Date.now() + this.resetTimeout;
      return;
    }

    if (this.state === 'CLOSED' && this.failures >= this.failureThreshold) {
      this.transition('OPEN');
      this.nextRetryTime = Date.now() + this.resetTimeout;
    }
  }

  /** Get current circuit stats */
  get stats(): CircuitStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalRequests: this.totalRequests,
      lastFailure: this.lastFailureTime,
      lastSuccess: this.lastSuccessTime,
    };
  }

  /** Force reset the circuit to CLOSED */
  reset(): void {
    this.failures = 0;
    this.halfOpenAttempts = 0;
    this.transition('CLOSED');
  }
}

export class CircuitOpenError extends Error {
  constructor(public circuitName: string, public retryAfter: number) {
    super(`Circuit breaker '${circuitName}' is OPEN. Retry after ${Math.ceil(retryAfter / 1000)}s`);
    this.name = 'CircuitOpenError';
  }
}
