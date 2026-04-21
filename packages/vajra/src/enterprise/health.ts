/**
 * Vajra Health Checks
 * Liveness, readiness, and detailed health probes.
 */

import type { Handler } from '../middleware';

type CheckStatus = 'healthy' | 'degraded' | 'unhealthy';

interface HealthCheck {
  name: string;
  check: () => Promise<CheckStatus | boolean> | CheckStatus | boolean;
  critical?: boolean;
}

interface HealthOptions {
  path?: string;
  livePath?: string;
  readyPath?: string;
  checks?: HealthCheck[];
  detailed?: boolean;
}

interface CheckResult {
  name: string;
  status: CheckStatus;
  duration: number;
}

async function runChecks(checks: HealthCheck[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of checks) {
    const start = performance.now();
    try {
      const result = await check.check();
      const status: CheckStatus = result === true ? 'healthy'
        : result === false ? 'unhealthy'
        : result;
      results.push({
        name: check.name,
        status,
        duration: Math.round((performance.now() - start) * 100) / 100,
      });
    } catch {
      results.push({
        name: check.name,
        status: 'unhealthy',
        duration: Math.round((performance.now() - start) * 100) / 100,
      });
    }
  }

  return results;
}

function overallStatus(results: CheckResult[], checks: HealthCheck[]): CheckStatus {
  let hasDegraded = false;
  const checkMap = new Map(checks.map(ch => [ch.name, ch]));

  for (const result of results) {
    const check = checkMap.get(result.name);
    if (result.status === 'unhealthy') {
      if (check?.critical !== false) return 'unhealthy';
      hasDegraded = true;
    }
    if (result.status === 'degraded') hasDegraded = true;
  }

  return hasDegraded ? 'degraded' : 'healthy';
}

export function healthCheck(options: HealthOptions = {}): {
  health: Handler;
  live: Handler;
  ready: Handler;
} {
  const checks = options.checks ?? [];
  const detailed = options.detailed ?? false;

  const health: Handler = async (c) => {
    if (checks.length === 0) {
      return c.json({ status: 'healthy', timestamp: new Date().toISOString() });
    }

    const results = await runChecks(checks);
    const status = overallStatus(results, checks);
    const httpStatus = status === 'unhealthy' ? 503 : 200;

    const body: Record<string, unknown> = {
      status,
      timestamp: new Date().toISOString(),
    };

    if (detailed) {
      body.checks = results;
    }

    return c.json(body, httpStatus);
  };

  const live: Handler = (c) => {
    return c.json({ status: 'alive', timestamp: new Date().toISOString() });
  };

  const ready: Handler = async (c) => {
    if (checks.length === 0) {
      return c.json({ status: 'ready', timestamp: new Date().toISOString() });
    }

    const criticalChecks = checks.filter(ch => ch.critical !== false);
    if (criticalChecks.length === 0) {
      return c.json({ status: 'ready', timestamp: new Date().toISOString() });
    }

    const results = await runChecks(criticalChecks);
    const allHealthy = results.every(r => r.status !== 'unhealthy');

    return c.json(
      { status: allHealthy ? 'ready' : 'not_ready', timestamp: new Date().toISOString() },
      allHealthy ? 200 : 503
    );
  };

  return { health, live, ready };
}

/** Convenience: register all health endpoints on an app */
export function registerHealthRoutes(
  app: { get: (path: string, handler: Handler) => unknown },
  options: HealthOptions = {}
): void {
  const { health, live, ready } = healthCheck(options);
  app.get(options.path ?? '/health', health);
  app.get(options.livePath ?? '/health/live', live);
  app.get(options.readyPath ?? '/health/ready', ready);
}
