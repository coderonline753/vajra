import { describe, test, expect } from 'bun:test';
import {
  createI18n,
  interpolate,
  getPluralCategory,
  formatNumber,
  formatDate,
  formatCurrency,
  type TFunction,
} from '../src/i18n';
import { Context } from '../src/context';

/* ═════════════ INTERPOLATION ═════════════ */

describe('interpolate', () => {
  test('replaces placeholders', () => {
    expect(interpolate('Hello, {name}!', { name: 'Rahul' })).toBe('Hello, Rahul!');
  });

  test('handles whitespace inside braces', () => {
    expect(interpolate('Hello, { name }!', { name: 'Priya' })).toBe('Hello, Priya!');
  });

  test('leaves unknown placeholders untouched', () => {
    expect(interpolate('Hello, {unknown}!', {})).toBe('Hello, {unknown}!');
  });

  test('coerces number and boolean values', () => {
    expect(interpolate('{n} items, {flag}', { n: 3, flag: true })).toBe('3 items, true');
  });
});

/* ═════════════ PLURAL CATEGORIES ═════════════ */

describe('getPluralCategory', () => {
  test('English: 1 is one, other is other', () => {
    expect(getPluralCategory(1, 'en')).toBe('one');
    expect(getPluralCategory(2, 'en')).toBe('other');
    expect(getPluralCategory(0, 'en')).toBe('other');
  });

  test('Hindi: same plural rule as English for basic counts', () => {
    expect(getPluralCategory(1, 'hi')).toBe('one');
    expect(getPluralCategory(2, 'hi')).toBe('other');
  });

  test('Arabic: has more plural categories', () => {
    const zero = getPluralCategory(0, 'ar');
    const one = getPluralCategory(1, 'ar');
    const two = getPluralCategory(2, 'ar');
    expect(['zero', 'one']).toContain(zero);
    expect(one).toBe('one');
    expect(two).toBe('two');
  });

  test('custom rules override Intl', () => {
    const result = getPluralCategory(5, 'xx', { xx: (n) => (n > 3 ? 'many' : 'few') });
    expect(result).toBe('many');
  });
});

/* ═════════════ TRANSLATE ═════════════ */

describe('createI18n · translate', () => {
  const i18n = createI18n({
    locales: {
      en: {
        hello: 'Hello, {name}!',
        nav: { home: 'Home', about: 'About' },
        items: { one: '{count} item', other: '{count} items' },
      },
      hi: {
        hello: 'Namaste, {name}!',
        nav: { home: 'Mukhya', about: 'Humare baare mein' },
      },
    },
    fallback: 'en',
  });

  test('returns simple translation', () => {
    expect(i18n.t('hello', { name: 'World' }, 'en')).toBe('Hello, World!');
  });

  test('returns other locale translation', () => {
    expect(i18n.t('hello', { name: 'Duniya' }, 'hi')).toBe('Namaste, Duniya!');
  });

  test('handles nested keys with dot notation', () => {
    expect(i18n.t('nav.home', {}, 'en')).toBe('Home');
    expect(i18n.t('nav.about', {}, 'hi')).toBe('Humare baare mein');
  });

  test('falls back to fallback locale when key missing in requested locale', () => {
    // 'items' only defined in en, but requested hi
    expect(i18n.t('items', { count: 1 }, 'hi')).toBe('1 item');
  });

  test('plural: one vs other', () => {
    expect(i18n.t('items', { count: 1 }, 'en')).toBe('1 item');
    expect(i18n.t('items', { count: 5 }, 'en')).toBe('5 items');
  });

  test('returns key when translation missing everywhere', () => {
    expect(i18n.t('does.not.exist', {}, 'en')).toBe('does.not.exist');
  });

  test('addLocale adds new locale at runtime', () => {
    i18n.addLocale('fr', { hello: 'Bonjour, {name}!' });
    expect(i18n.t('hello', { name: 'Marie' }, 'fr')).toBe('Bonjour, Marie!');
    expect(i18n.getLocales()).toContain('fr');
  });
});

/* ═════════════ LOCALE DETECTION ═════════════ */

describe('createI18n · detectLocale', () => {
  const i18n = createI18n({
    locales: {
      en: { hi: 'Hi' },
      hi: { hi: 'Namaste' },
      fr: { hi: 'Salut' },
    },
    fallback: 'en',
    defaultLocale: 'en',
  });

  test('query param wins', () => {
    const ctx = new Context(new Request('http://localhost/?lang=hi'));
    expect(i18n.detectLocale(ctx)).toBe('hi');
  });

  test('cookie used when no query', () => {
    const ctx = new Context(new Request('http://localhost/', {
      headers: { cookie: 'locale=fr' },
    }));
    expect(i18n.detectLocale(ctx)).toBe('fr');
  });

  test('Accept-Language used when no cookie', () => {
    const ctx = new Context(new Request('http://localhost/', {
      headers: { 'accept-language': 'hi-IN,hi;q=0.9,en;q=0.8' },
    }));
    expect(i18n.detectLocale(ctx)).toBe('hi');
  });

  test('Accept-Language strips region', () => {
    const ctx = new Context(new Request('http://localhost/', {
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    }));
    expect(i18n.detectLocale(ctx)).toBe('en');
  });

  test('falls back to default when nothing matches', () => {
    const ctx = new Context(new Request('http://localhost/', {
      headers: { 'accept-language': 'de,it;q=0.8' },
    }));
    expect(i18n.detectLocale(ctx)).toBe('en');
  });

  test('query locale ignored if not in locales', () => {
    const ctx = new Context(new Request('http://localhost/?lang=xx'));
    expect(i18n.detectLocale(ctx)).toBe('en');
  });
});

/* ═════════════ MIDDLEWARE ═════════════ */

describe('i18n middleware', () => {
  test('injects t() and locale into ctx', async () => {
    const i18n = createI18n({
      locales: { en: { hi: 'Hi, {name}' }, hi: { hi: 'Namaste, {name}' } },
      fallback: 'en',
    });
    const mw = i18n.middleware();

    const ctx = new Context(new Request('http://localhost/?lang=hi'));
    let received = '';
    await mw(ctx, async () => {
      const t = ctx.get<TFunction>('t')!;
      received = t('hi', { name: 'Team' });
      expect(ctx.get('locale')).toBe('hi');
    });
    expect(received).toBe('Namaste, Team');
  });
});

/* ═════════════ FORMAT HELPERS ═════════════ */

describe('formatters', () => {
  test('formatNumber respects locale', () => {
    expect(formatNumber(1234567, 'en-US')).toBe('1,234,567');
    // Hindi uses Indian grouping: 12,34,567
    expect(formatNumber(1234567, 'hi-IN')).toMatch(/12,?34,?567/);
  });

  test('formatCurrency renders ₹/$/etc', () => {
    const usd = formatCurrency(99.5, 'USD', 'en-US');
    expect(usd).toContain('99.5');
    expect(usd).toContain('$');

    const inr = formatCurrency(999, 'INR', 'en-IN');
    expect(inr).toMatch(/₹|INR/);
  });

  test('formatDate produces output', () => {
    const date = new Date('2026-04-20T12:00:00Z');
    const formatted = formatDate(date, 'en-US', { dateStyle: 'long' });
    expect(formatted).toContain('2026');
  });

  test('formatters gracefully handle invalid locale', () => {
    expect(formatNumber(42, 'zz')).toBe('42');
  });
});

/* ═════════════ ERROR HANDLING ═════════════ */

describe('createI18n · errors', () => {
  test('throws if fallback locale is missing', () => {
    expect(() => createI18n({
      locales: { en: { hi: 'Hi' } },
      fallback: 'missing',
    })).toThrow(/not in locales/);
  });
});
