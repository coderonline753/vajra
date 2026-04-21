import { describe, it, expect } from 'bun:test';
import { ClusterManager, generateNginxUpstream, generateSystemdService } from '../src/index';

describe('ClusterManager', () => {
  it('isWorker() returns false in main process', () => {
    delete process.env.VAJRA_CLUSTER;
    expect(ClusterManager.isWorker()).toBe(false);
  });

  it('isWorker() returns true when env set', () => {
    process.env.VAJRA_CLUSTER = 'true';
    expect(ClusterManager.isWorker()).toBe(true);
    delete process.env.VAJRA_CLUSTER;
  });

  it('workerId() returns 0 by default', () => {
    delete process.env.VAJRA_WORKER_ID;
    expect(ClusterManager.workerId()).toBe(0);
  });

  it('workerId() reads env', () => {
    process.env.VAJRA_WORKER_ID = '3';
    expect(ClusterManager.workerId()).toBe(3);
    delete process.env.VAJRA_WORKER_ID;
  });

  it('status() returns empty before start', () => {
    const manager = new ClusterManager({ script: './test.ts', workers: 2, basePort: 9000 });
    expect(manager.status()).toEqual([]);
  });
});

describe('generateNginxUpstream', () => {
  it('generates upstream block with correct ports', () => {
    const config = generateNginxUpstream({ workers: 4, basePort: 3000 });
    expect(config).toContain('upstream vajra_app');
    expect(config).toContain('server 127.0.0.1:3000;');
    expect(config).toContain('server 127.0.0.1:3001;');
    expect(config).toContain('server 127.0.0.1:3002;');
    expect(config).toContain('server 127.0.0.1:3003;');
    expect(config).toContain('least_conn');
  });

  it('uses custom upstream name', () => {
    const config = generateNginxUpstream({ name: 'my_api', workers: 2, basePort: 8000 });
    expect(config).toContain('upstream my_api');
    expect(config).toContain('proxy_pass http://my_api');
  });

  it('uses custom domain', () => {
    const config = generateNginxUpstream({ workers: 2, domain: 'vajra.run' });
    expect(config).toContain('server_name vajra.run');
  });

  it('generates HTTP config by default', () => {
    const config = generateNginxUpstream({ workers: 2 });
    expect(config).toContain('listen 80');
    expect(config).not.toContain('listen 443');
    expect(config).not.toContain('ssl_certificate');
  });

  it('generates SSL config when ssl provided', () => {
    const config = generateNginxUpstream({
      workers: 2,
      domain: 'vajra.run',
      ssl: { cert: '/etc/ssl/cert.pem', key: '/etc/ssl/key.pem' },
    });
    expect(config).toContain('listen 443 ssl http2');
    expect(config).toContain('ssl_certificate /etc/ssl/cert.pem');
    expect(config).toContain('ssl_certificate_key /etc/ssl/key.pem');
    expect(config).toContain('return 301 https://');
  });

  it('adds WebSocket headers when enabled', () => {
    const config = generateNginxUpstream({ workers: 2, websocket: true });
    expect(config).toContain('Upgrade $http_upgrade');
    expect(config).toContain('Connection "upgrade"');
  });

  it('no WebSocket headers by default', () => {
    const config = generateNginxUpstream({ workers: 2 });
    expect(config).not.toContain('Upgrade');
  });

  it('includes standard proxy headers', () => {
    const config = generateNginxUpstream({ workers: 1 });
    expect(config).toContain('X-Real-IP');
    expect(config).toContain('X-Forwarded-For');
    expect(config).toContain('X-Forwarded-Proto');
    expect(config).toContain('proxy_http_version 1.1');
  });

  it('single worker generates one server line', () => {
    const config = generateNginxUpstream({ workers: 1, basePort: 5000 });
    expect(config).toContain('server 127.0.0.1:5000;');
    expect(config).not.toContain('server 127.0.0.1:5001;');
  });
});

describe('generateSystemdService', () => {
  it('generates valid service file', () => {
    const service = generateSystemdService({
      name: 'vajra-app',
      script: '/home/app/cluster.ts',
    });
    expect(service).toContain('[Unit]');
    expect(service).toContain('[Service]');
    expect(service).toContain('[Install]');
    expect(service).toContain('ExecStart=/usr/local/bin/bun run /home/app/cluster.ts');
    expect(service).toContain('Restart=on-failure');
    expect(service).toContain('WantedBy=multi-user.target');
  });

  it('uses custom user', () => {
    const service = generateSystemdService({
      name: 'api',
      script: './app.ts',
      user: 'deploy',
    });
    expect(service).toContain('User=deploy');
  });

  it('uses custom working directory', () => {
    const service = generateSystemdService({
      name: 'api',
      script: './app.ts',
      workingDir: '/opt/vajra',
    });
    expect(service).toContain('WorkingDirectory=/opt/vajra');
    expect(service).toContain('ReadWritePaths=/opt/vajra');
  });

  it('includes env vars', () => {
    const service = generateSystemdService({
      name: 'api',
      script: './app.ts',
      env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://localhost/db' },
    });
    expect(service).toContain('Environment="NODE_ENV=production"');
    expect(service).toContain('Environment="DATABASE_URL=postgres://localhost/db"');
  });

  it('sets file descriptor limits', () => {
    const service = generateSystemdService({ name: 'api', script: './app.ts' });
    expect(service).toContain('LimitNOFILE=65535');
    expect(service).toContain('LimitNPROC=65535');
  });

  it('includes security hardening', () => {
    const service = generateSystemdService({ name: 'api', script: './app.ts' });
    expect(service).toContain('NoNewPrivileges=true');
    expect(service).toContain('ProtectSystem=strict');
  });

  it('includes description with name', () => {
    const service = generateSystemdService({ name: 'my-cool-app', script: './app.ts' });
    expect(service).toContain('Description=Vajra my-cool-app');
  });
});
