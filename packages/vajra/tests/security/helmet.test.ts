import { describe, it, expect } from 'bun:test';
import { Vajra, helmet } from '../../src/index';

describe('Helmet', () => {
  it('sets all default security headers', async () => {
    const app = new Vajra();
    app.use(helmet());
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-xss-protection')).toBe('0');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
  });

  it('custom CSP directives', async () => {
    const app = new Vajra();
    app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", 'cdn.example.com'],
          'img-src': ['*'],
        },
      },
    }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' cdn.example.com");
    expect(csp).toContain('img-src *');
  });

  it('CSP report-only mode', async () => {
    const app = new Vajra();
    app.use(helmet({
      contentSecurityPolicy: {
        directives: { 'default-src': ["'self'"] },
        reportOnly: true,
      },
    }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.has('content-security-policy-report-only')).toBe(true);
    expect(res.headers.has('content-security-policy')).toBe(false);
  });

  it('individual headers can be disabled', async () => {
    const app = new Vajra();
    app.use(helmet({
      xFrameOptions: false,
      contentSecurityPolicy: false,
      strictTransportSecurity: false,
    }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.has('x-frame-options')).toBe(false);
    expect(res.headers.has('content-security-policy')).toBe(false);
    expect(res.headers.has('strict-transport-security')).toBe(false);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('SAMEORIGIN frame option', async () => {
    const app = new Vajra();
    app.use(helmet({ xFrameOptions: 'SAMEORIGIN' }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('cross-origin policies', async () => {
    const app = new Vajra();
    app.use(helmet({
      crossOriginEmbedderPolicy: 'require-corp',
      crossOriginOpenerPolicy: 'same-origin',
      crossOriginResourcePolicy: 'same-origin',
    }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('does not overwrite existing headers', async () => {
    const app = new Vajra();
    app.use(helmet());
    app.get('/', (c) => {
      return c.setHeader('content-security-policy', "default-src 'none'").text('ok');
    });

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
  });
});
