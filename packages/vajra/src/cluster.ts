/**
 * Vajra Cluster — Multi-Process for Bun
 *
 * Bun has no built-in cluster module like Node.js.
 * Vajra Cluster spawns N Bun processes on sequential ports,
 * each running your app. Pair with Nginx upstream for load balancing.
 *
 * Philosophy: explicit, no magic. You see every port, every process.
 * "Ek baar banao, saalon tak mat chedo."
 *
 * @example
 *   // cluster.ts — run this instead of your app directly
 *   import { cluster } from 'vajrajs';
 *
 *   cluster({
 *     script: './src/index.ts',
 *     workers: 4,           // default: CPU cores
 *     basePort: 3000,       // ports: 3000, 3001, 3002, 3003
 *     healthPath: '/health/live',
 *     restartDelay: 1000,
 *     maxRestarts: 10,
 *   });
 *
 *   // Your app reads PORT from env (Vajra Cluster sets it per worker)
 *   // app.listen(Number(process.env.PORT) || 3000);
 *
 *   // Generate Nginx config:
 *   import { generateNginxUpstream } from 'vajrajs';
 *   console.log(generateNginxUpstream({ name: 'vajra_app', workers: 4, basePort: 3000 }));
 */

import { cpus } from 'os';

/* ═══════ TYPES ═══════ */

export interface ClusterOptions {
  /** Path to the Bun script to run. */
  script: string;
  /** Number of worker processes. Default: CPU core count. */
  workers?: number;
  /** Starting port. Workers get basePort, basePort+1, etc. Default: 3000 */
  basePort?: number;
  /** Health check endpoint path. Default: '/health/live' */
  healthPath?: string;
  /** Health check interval in ms. Default: 10000 (10s) */
  healthInterval?: number;
  /** Health check timeout in ms. Default: 3000 (3s) */
  healthTimeout?: number;
  /** Delay before restarting a crashed worker (ms). Default: 1000 */
  restartDelay?: number;
  /** Max restarts per worker before giving up. Default: 10 */
  maxRestarts?: number;
  /** Extra env vars passed to each worker. */
  env?: Record<string, string>;
  /** Callback when a worker starts. */
  onWorkerStart?: (id: number, port: number, pid: number) => void;
  /** Callback when a worker crashes. */
  onWorkerCrash?: (id: number, port: number, code: number | null) => void;
  /** Callback when a worker passes health check. */
  onWorkerHealthy?: (id: number, port: number) => void;
  /** Callback when a worker fails health check. */
  onWorkerUnhealthy?: (id: number, port: number) => void;
}

interface WorkerState {
  id: number;
  port: number;
  process: ReturnType<typeof Bun.spawn> | null;
  restarts: number;
  healthy: boolean;
  lastHealthCheck: number;
}

/* ═══════ CLUSTER MANAGER ═══════ */

export class ClusterManager {
  private workers: WorkerState[] = [];
  private opts: Required<Omit<ClusterOptions, 'env' | 'onWorkerStart' | 'onWorkerCrash' | 'onWorkerHealthy' | 'onWorkerUnhealthy'>> & ClusterOptions;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: ClusterOptions) {
    this.opts = {
      workers: cpus().length,
      basePort: 3000,
      healthPath: '/health/live',
      healthInterval: 10_000,
      healthTimeout: 3_000,
      restartDelay: 1_000,
      maxRestarts: 10,
      ...options,
    };
  }

  /** Start all workers */
  async start(): Promise<void> {
    this.running = true;
    const { workers, basePort, script } = this.opts;

    console.log(`\n  Vajra Cluster: starting ${workers} workers on ports ${basePort}..${basePort + workers - 1}`);
    console.log(`  Script: ${script}\n`);

    for (let i = 0; i < workers; i++) {
      const port = basePort + i;
      const state: WorkerState = {
        id: i,
        port,
        process: null,
        restarts: 0,
        healthy: false,
        lastHealthCheck: 0,
      };
      this.workers.push(state);
      this.spawnWorker(state);
    }

    // Start health checks
    this.healthTimer = setInterval(() => this.checkHealth(), this.opts.healthInterval);
    if (this.healthTimer.unref) this.healthTimer.unref();

    // Graceful shutdown
    const shutdown = () => this.stop();
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  /** Stop all workers gracefully */
  async stop(): Promise<void> {
    this.running = false;
    console.log('\n  Vajra Cluster: shutting down...');

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    // Send SIGTERM to all workers
    for (const worker of this.workers) {
      if (worker.process) {
        worker.process.kill('SIGTERM');
      }
    }

    // Wait max 30s for workers to exit
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const alive = this.workers.filter(w => w.process && !w.process.killed);
      if (alive.length === 0) break;
      await new Promise(r => setTimeout(r, 500));
    }

    // Force kill remaining
    for (const worker of this.workers) {
      if (worker.process && !worker.process.killed) {
        worker.process.kill('SIGKILL');
      }
    }

    console.log('  Vajra Cluster: all workers stopped\n');
    process.exit(0);
  }

  /** Spawn a single worker process */
  private spawnWorker(state: WorkerState): void {
    if (!this.running) return;

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PORT: String(state.port),
      VAJRA_WORKER_ID: String(state.id),
      VAJRA_CLUSTER: 'true',
      ...this.opts.env,
    };

    const proc = Bun.spawn(['bun', 'run', this.opts.script], {
      env,
      stdout: 'inherit',
      stderr: 'inherit',
      onExit: (_, code) => {
        if (!this.running) return;

        state.process = null;
        state.healthy = false;
        this.opts.onWorkerCrash?.(state.id, state.port, code);

        if (state.restarts >= this.opts.maxRestarts) {
          console.error(`  Worker ${state.id} (port ${state.port}): max restarts (${this.opts.maxRestarts}) reached, giving up`);
          return;
        }

        state.restarts++;
        console.log(`  Worker ${state.id} (port ${state.port}): restarting in ${this.opts.restartDelay}ms (restart ${state.restarts}/${this.opts.maxRestarts})`);

        setTimeout(() => this.spawnWorker(state), this.opts.restartDelay);
      },
    });

    state.process = proc;
    state.healthy = false;
    console.log(`  Worker ${state.id} (port ${state.port}): started (pid ${proc.pid})`);
    this.opts.onWorkerStart?.(state.id, state.port, proc.pid);
  }

  /** Check health of all workers */
  private async checkHealth(): Promise<void> {
    const checks = this.workers.map(async (worker) => {
      if (!worker.process || worker.process.killed) return;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.opts.healthTimeout);

        const res = await fetch(`http://localhost:${worker.port}${this.opts.healthPath}`, {
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const wasHealthy = worker.healthy;
        worker.healthy = res.ok;
        worker.lastHealthCheck = Date.now();

        if (res.ok && !wasHealthy) {
          this.opts.onWorkerHealthy?.(worker.id, worker.port);
        } else if (!res.ok && wasHealthy) {
          this.opts.onWorkerUnhealthy?.(worker.id, worker.port);
          console.warn(`  Worker ${worker.id} (port ${worker.port}): unhealthy (status ${res.status})`);
        }
      } catch {
        if (worker.healthy) {
          worker.healthy = false;
          this.opts.onWorkerUnhealthy?.(worker.id, worker.port);
          console.warn(`  Worker ${worker.id} (port ${worker.port}): health check failed`);
        }
      }
    });

    await Promise.allSettled(checks);
  }

  /** Get current status of all workers */
  status(): Array<{ id: number; port: number; pid: number | null; healthy: boolean; restarts: number }> {
    return this.workers.map(w => ({
      id: w.id,
      port: w.port,
      pid: w.process?.pid ?? null,
      healthy: w.healthy,
      restarts: w.restarts,
    }));
  }

  /** Check if running in a cluster worker (child process) */
  static isWorker(): boolean {
    return process.env.VAJRA_CLUSTER === 'true';
  }

  /** Get worker ID (0-based) inside a cluster worker */
  static workerId(): number {
    return Number(process.env.VAJRA_WORKER_ID ?? 0);
  }
}

/* ═══════ CONVENIENCE API ═══════ */

/**
 * Start a Vajra cluster.
 *
 * @example
 *   cluster({
 *     script: './src/index.ts',
 *     workers: 4,
 *     basePort: 3000,
 *   });
 */
export function cluster(options: ClusterOptions): ClusterManager {
  const manager = new ClusterManager(options);
  manager.start();
  return manager;
}

/* ═══════ NGINX CONFIG GENERATOR ═══════ */

export interface NginxUpstreamOptions {
  /** Upstream block name. Default: 'vajra_app' */
  name?: string;
  /** Number of workers. */
  workers: number;
  /** Base port. Default: 3000 */
  basePort?: number;
  /** Domain name. Default: 'example.com' */
  domain?: string;
  /** Enable WebSocket support. Default: false */
  websocket?: boolean;
  /** SSL cert paths (optional, generates HTTPS block) */
  ssl?: { cert: string; key: string };
}

/**
 * Generate Nginx upstream + server config for Vajra cluster.
 *
 * @example
 *   const config = generateNginxUpstream({
 *     name: 'vajra_app',
 *     workers: 4,
 *     basePort: 3000,
 *     domain: 'vajra.run',
 *     websocket: true,
 *     ssl: { cert: '/etc/letsencrypt/live/vajra.run/fullchain.pem', key: '/etc/letsencrypt/live/vajra.run/privkey.pem' },
 *   });
 */
export function generateNginxUpstream(options: NginxUpstreamOptions): string {
  const name = options.name ?? 'vajra_app';
  const basePort = options.basePort ?? 3000;
  const domain = options.domain ?? 'example.com';
  const ws = options.websocket ?? false;

  const servers = Array.from({ length: options.workers }, (_, i) =>
    `    server 127.0.0.1:${basePort + i};`
  ).join('\n');

  let config = `upstream ${name} {\n    least_conn;\n${servers}\n}\n\n`;

  const proxyBlock = [
    `    location / {`,
    `        proxy_pass http://${name};`,
    `        proxy_http_version 1.1;`,
    `        proxy_set_header Host $host;`,
    `        proxy_set_header X-Real-IP $remote_addr;`,
    `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `        proxy_set_header X-Forwarded-Proto $scheme;`,
  ];

  if (ws) {
    proxyBlock.push(
      `        proxy_set_header Upgrade $http_upgrade;`,
      `        proxy_set_header Connection "upgrade";`,
    );
  }

  proxyBlock.push(`    }`);

  if (options.ssl) {
    config += `server {\n`;
    config += `    listen 80;\n    server_name ${domain};\n    return 301 https://$host$request_uri;\n}\n\n`;
    config += `server {\n`;
    config += `    listen 443 ssl http2;\n`;
    config += `    server_name ${domain};\n\n`;
    config += `    ssl_certificate ${options.ssl.cert};\n`;
    config += `    ssl_certificate_key ${options.ssl.key};\n\n`;
    config += proxyBlock.join('\n') + '\n';
    config += `}\n`;
  } else {
    config += `server {\n`;
    config += `    listen 80;\n`;
    config += `    server_name ${domain};\n\n`;
    config += proxyBlock.join('\n') + '\n';
    config += `}\n`;
  }

  return config;
}

/**
 * Generate systemd service file for Vajra cluster.
 *
 * @example
 *   const service = generateSystemdService({
 *     name: 'vajra-app',
 *     script: '/home/app/cluster.ts',
 *     user: 'app',
 *     workingDir: '/home/app',
 *   });
 */
export function generateSystemdService(options: {
  name: string;
  script: string;
  user?: string;
  workingDir?: string;
  env?: Record<string, string>;
}): string {
  const envLines = options.env
    ? Object.entries(options.env).map(([k, v]) => `Environment="${k}=${v}"`).join('\n')
    : '';

  return `[Unit]
Description=Vajra ${options.name}
After=network.target

[Service]
Type=simple
User=${options.user ?? 'root'}
WorkingDirectory=${options.workingDir ?? '/home/app'}
ExecStart=/usr/local/bin/bun run ${options.script}
Restart=on-failure
RestartSec=5
${envLines}

# Resource limits
LimitNOFILE=65535
LimitNPROC=65535

# Security
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${options.workingDir ?? '/home/app'}

[Install]
WantedBy=multi-user.target
`;
}
