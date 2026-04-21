import { describe, it, expect } from 'bun:test';
import { Vajra, ipFilter, isIpInCidr } from '../../src/index';

describe('IP Filter', () => {
  it('whitelist allows listed IP', async () => {
    const app = new Vajra();
    app.use(ipFilter({ mode: 'whitelist', ips: ['10.0.0.1'] }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    }));
    expect(res.status).toBe(200);
  });

  it('whitelist blocks unlisted IP', async () => {
    const app = new Vajra();
    app.use(ipFilter({ mode: 'whitelist', ips: ['10.0.0.1'] }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    }));
    expect(res.status).toBe(403);
  });

  it('blacklist blocks listed IP', async () => {
    const app = new Vajra();
    app.use(ipFilter({ mode: 'blacklist', ips: ['10.0.0.1'] }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    }));
    expect(res.status).toBe(403);
  });

  it('blacklist allows unlisted IP', async () => {
    const app = new Vajra();
    app.use(ipFilter({ mode: 'blacklist', ips: ['10.0.0.1'] }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    }));
    expect(res.status).toBe(200);
  });

  it('CIDR range matching works', async () => {
    const app = new Vajra();
    app.use(ipFilter({ mode: 'whitelist', ips: ['10.0.0.0/8'] }));
    app.get('/', (c) => c.text('ok'));

    const res1 = await app.handle(new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '10.1.2.3' },
    }));
    expect(res1.status).toBe(200);

    const res2 = await app.handle(new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '11.0.0.1' },
    }));
    expect(res2.status).toBe(403);
  });

  it('mixed exact IPs and CIDRs', async () => {
    const app = new Vajra();
    app.use(ipFilter({ mode: 'whitelist', ips: ['192.168.1.100', '10.0.0.0/24'] }));
    app.get('/', (c) => c.text('ok'));

    const r1 = await app.handle(new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '192.168.1.100' },
    }));
    expect(r1.status).toBe(200);

    const r2 = await app.handle(new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '10.0.0.50' },
    }));
    expect(r2.status).toBe(200);
  });

  it('custom onDenied handler', async () => {
    const app = new Vajra();
    app.use(ipFilter({
      mode: 'whitelist',
      ips: ['10.0.0.1'],
      onDenied: (c, ip) => c.json({ blocked: true, ip }, 403),
    }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
    }));
    expect(res.status).toBe(403);
    const data = await res.json() as any;
    expect(data.blocked).toBe(true);
    expect(data.ip).toBe('1.2.3.4');
  });
});

describe('isIpInCidr utility', () => {
  it('matches IPs in range', () => {
    expect(isIpInCidr('10.0.0.1', '10.0.0.0/8')).toBe(true);
    expect(isIpInCidr('10.255.255.255', '10.0.0.0/8')).toBe(true);
    expect(isIpInCidr('192.168.1.50', '192.168.1.0/24')).toBe(true);
  });

  it('rejects IPs out of range', () => {
    expect(isIpInCidr('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(isIpInCidr('192.168.2.1', '192.168.1.0/24')).toBe(false);
  });

  it('/32 matches exact IP only', () => {
    expect(isIpInCidr('10.0.0.1', '10.0.0.1/32')).toBe(true);
    expect(isIpInCidr('10.0.0.2', '10.0.0.1/32')).toBe(false);
  });
});
