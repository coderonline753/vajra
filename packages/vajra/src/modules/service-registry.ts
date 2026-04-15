/**
 * Vajra Service Registry
 * Service discovery for microservices mode. In-memory for dev, pluggable for prod.
 */

export interface ServiceInstance {
  id: string;
  name: string;
  host: string;
  port: number;
  metadata?: Record<string, string>;
  healthUrl?: string;
  registeredAt: number;
  lastHeartbeat: number;
  status: 'healthy' | 'unhealthy' | 'draining';
}

interface RegistryOptions {
  heartbeatInterval?: number;
  unhealthyThreshold?: number;
  onRegister?: (instance: ServiceInstance) => void;
  onDeregister?: (instance: ServiceInstance) => void;
  onUnhealthy?: (instance: ServiceInstance) => void;
}

export class ServiceRegistry {
  private services = new Map<string, Map<string, ServiceInstance>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: number;
  private unhealthyThreshold: number;
  private options: RegistryOptions;

  constructor(options: RegistryOptions = {}) {
    this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
    this.unhealthyThreshold = options.unhealthyThreshold ?? 90_000;
    this.options = options;
  }

  /** Register a service instance */
  register(name: string, host: string, port: number, metadata?: Record<string, string>): ServiceInstance {
    const id = `${name}-${host}-${port}`;
    const now = Date.now();

    const instance: ServiceInstance = {
      id,
      name,
      host,
      port,
      metadata,
      healthUrl: `http://${host}:${port}/health`,
      registeredAt: now,
      lastHeartbeat: now,
      status: 'healthy',
    };

    if (!this.services.has(name)) {
      this.services.set(name, new Map());
    }
    this.services.get(name)!.set(id, instance);
    this.options.onRegister?.(instance);

    return instance;
  }

  /** Deregister a service instance */
  deregister(name: string, id: string): boolean {
    const instances = this.services.get(name);
    if (!instances) return false;

    const instance = instances.get(id);
    if (!instance) return false;

    instances.delete(id);
    this.options.onDeregister?.(instance);

    if (instances.size === 0) {
      this.services.delete(name);
    }
    return true;
  }

  /** Send heartbeat for a service instance */
  heartbeat(name: string, id: string): boolean {
    const instances = this.services.get(name);
    if (!instances) return false;

    const instance = instances.get(id);
    if (!instance) return false;

    instance.lastHeartbeat = Date.now();
    instance.status = 'healthy';
    return true;
  }

  /** Get all healthy instances of a service */
  getInstances(name: string): ServiceInstance[] {
    const instances = this.services.get(name);
    if (!instances) return [];
    return [...instances.values()].filter(i => i.status === 'healthy');
  }

  /** Get one instance (round-robin load balancing) */
  private roundRobinCounters = new Map<string, number>();

  getInstance(name: string): ServiceInstance | null {
    const healthy = this.getInstances(name);
    if (healthy.length === 0) return null;

    const counter = (this.roundRobinCounters.get(name) ?? 0) % healthy.length;
    this.roundRobinCounters.set(name, counter + 1);
    return healthy[counter];
  }

  /** Get all registered service names */
  get serviceNames(): string[] {
    return [...this.services.keys()];
  }

  /** Get total instance count */
  get totalInstances(): number {
    let count = 0;
    for (const instances of this.services.values()) {
      count += instances.size;
    }
    return count;
  }

  /** Start heartbeat monitoring */
  startMonitoring(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [, instances] of this.services) {
        for (const [, instance] of instances) {
          if (instance.status === 'healthy' && now - instance.lastHeartbeat > this.unhealthyThreshold) {
            instance.status = 'unhealthy';
            this.options.onUnhealthy?.(instance);
          }
        }
      }
    }, this.heartbeatInterval);

    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  /** Stop heartbeat monitoring */
  stopMonitoring(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Clear all services */
  clear(): void {
    this.services.clear();
    this.roundRobinCounters.clear();
  }
}
