import { describe, it, expect } from 'bun:test';
import { Vajra, healthCheck, registerHealthRoutes } from '../../src/index';

describe('Health Checks', () => {
  it('basic health returns healthy', async () => {
    const app = new Vajra();
    const { health } = healthCheck();
    app.get('/health', health);

    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe('healthy');
    expect(data.timestamp).toBeTruthy();
  });

  it('liveness probe returns alive', async () => {
    const app = new Vajra();
    const { live } = healthCheck();
    app.get('/health/live', live);

    const res = await app.handle(new Request('http://localhost/health/live'));
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe('alive');
  });

  it('readiness with healthy checks returns ready', async () => {
    const app = new Vajra();
    const { ready } = healthCheck({
      checks: [
        { name: 'db', check: () => true, critical: true },
      ],
    });
    app.get('/health/ready', ready);

    const res = await app.handle(new Request('http://localhost/health/ready'));
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe('ready');
  });

  it('readiness with unhealthy critical check returns 503', async () => {
    const app = new Vajra();
    const { ready } = healthCheck({
      checks: [
        { name: 'db', check: () => false, critical: true },
      ],
    });
    app.get('/health/ready', ready);

    const res = await app.handle(new Request('http://localhost/health/ready'));
    expect(res.status).toBe(503);
    const data = await res.json() as any;
    expect(data.status).toBe('not_ready');
  });

  it('detailed health shows check results', async () => {
    const app = new Vajra();
    const { health } = healthCheck({
      detailed: true,
      checks: [
        { name: 'db', check: () => 'healthy' },
        { name: 'cache', check: () => 'degraded' },
      ],
    });
    app.get('/health', health);

    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe('degraded');
    expect(data.checks).toHaveLength(2);
    expect(data.checks[0].name).toBe('db');
    expect(data.checks[1].status).toBe('degraded');
  });

  it('check that throws is treated as unhealthy', async () => {
    const app = new Vajra();
    const { health } = healthCheck({
      detailed: true,
      checks: [
        { name: 'broken', check: () => { throw new Error('crash'); } },
      ],
    });
    app.get('/health', health);

    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(503);
  });

  it('registerHealthRoutes convenience function', async () => {
    const app = new Vajra();
    registerHealthRoutes(app);

    const r1 = await app.handle(new Request('http://localhost/health'));
    expect(r1.status).toBe(200);

    const r2 = await app.handle(new Request('http://localhost/health/live'));
    expect(r2.status).toBe(200);

    const r3 = await app.handle(new Request('http://localhost/health/ready'));
    expect(r3.status).toBe(200);
  });
});
