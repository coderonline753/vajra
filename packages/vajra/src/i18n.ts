/**
 * Vajra i18n Module
 * Locale detection · translations · interpolation · pluralization (CLDR-ish).
 * Pure TypeScript, zero dependencies.
 *
 * const i18n = createI18n({
 *   locales: { en: { hello: 'Hello, {name}!' }, hi: { hello: 'Namaste, {name}!' } },
 *   fallback: 'en',
 * });
 *
 * app.use(i18n.middleware());
 * app.get('/', async (ctx) => {
 *   const t = ctx.get('t') as TFunction;
 *   return ctx.json({ msg: t('hello', { name: 'World' }) });
 * });
 */

import type { Context } from './context';
import type { Middleware } from './middleware';

/* ═════════════ TYPES ═════════════ */

export type TranslationValue = string | { [key: string]: TranslationValue };
export type TranslationTree = Record<string, TranslationValue>;

export interface I18nOptions {
  /** Map of locale code → translation tree */
  locales: Record<string, TranslationTree>;
  /** Fallback locale when requested is missing. Default: first key in locales */
  fallback?: string;
  /** Default locale before request-based detection (also used in non-HTTP contexts) */
  defaultLocale?: string;
  /** Cookie name for locale preference. Default: 'locale' */
  cookieName?: string;
  /** Query param for locale override. Default: 'lang' */
  queryParam?: string;
  /** If true, respect Accept-Language header. Default: true */
  acceptHeader?: boolean;
  /** Custom pluralization rules (Intl.PluralRules used by default) */
  pluralRules?: Record<string, (n: number) => PluralCategory>;
}

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export interface TFunction {
  (key: string, values?: Record<string, unknown>): string;
  locale: string;
}

export interface I18n {
  t(key: string, values?: Record<string, unknown>, locale?: string): string;
  detectLocale(ctx: Context): string;
  createT(locale: string): TFunction;
  middleware(): Middleware;
  addLocale(locale: string, tree: TranslationTree): void;
  getLocales(): string[];
}

/* ═════════════ FACTORY ═════════════ */

export function createI18n(options: I18nOptions): I18n {
  const locales: Record<string, TranslationTree> = { ...options.locales };
  const localeList = Object.keys(locales);
  const fallback = options.fallback ?? localeList[0] ?? 'en';
  const defaultLocale = options.defaultLocale ?? fallback;
  const cookieName = options.cookieName ?? 'locale';
  const queryParam = options.queryParam ?? 'lang';
  const acceptHeader = options.acceptHeader !== false;
  const pluralRules = options.pluralRules ?? {};

  if (!locales[fallback]) {
    throw new Error(`i18n: fallback locale "${fallback}" not in locales`);
  }

  const resolveKey = (tree: TranslationTree, key: string): string | null => {
    const parts = key.split('.');
    let node: TranslationValue = tree as TranslationValue;
    for (const part of parts) {
      if (typeof node !== 'object' || node === null) return null;
      node = (node as TranslationTree)[part] ?? null as any;
      if (node === null || node === undefined) return null;
    }
    if (typeof node === 'string') return node;
    if (typeof node === 'object' && node !== null) {
      // Might be plural object ({ one: '...', other: '...' })
      return null;
    }
    return null;
  };

  const resolvePluralForm = (tree: TranslationTree, key: string, count: number, locale: string): string | null => {
    const parts = key.split('.');
    let node: TranslationValue = tree as TranslationValue;
    for (const part of parts) {
      if (typeof node !== 'object' || node === null) return null;
      node = (node as TranslationTree)[part] ?? null as any;
      if (node === null || node === undefined) return null;
    }
    if (typeof node !== 'object' || node === null) return null;

    const category = getPluralCategory(count, locale, pluralRules);
    const pluralTree = node as TranslationTree;
    const specific = pluralTree[category] ?? pluralTree['other'];
    return typeof specific === 'string' ? specific : null;
  };

  function translate(key: string, values: Record<string, unknown> = {}, locale: string): string {
    const count = values.count;
    const tree = locales[locale] ?? locales[fallback]!;
    const fallbackTree = locales[fallback]!;

    let template: string | null = null;
    if (typeof count === 'number') {
      template = resolvePluralForm(tree, key, count, locale)
        ?? resolvePluralForm(fallbackTree, key, count, fallback);
    }
    if (template == null) {
      template = resolveKey(tree, key) ?? resolveKey(fallbackTree, key);
    }
    if (template == null) return key; // missing key → return key itself

    return interpolate(template, values);
  }

  const detectFromAcceptHeader = (header: string): string | null => {
    // Accept-Language: en-US,en;q=0.9,hi;q=0.8
    const ranges = header.split(',').map((range) => {
      const [tag, qStr] = range.trim().split(';q=');
      return { tag: tag!.trim().toLowerCase(), q: qStr ? parseFloat(qStr) : 1.0 };
    }).filter((r) => r.tag && r.q > 0).sort((a, b) => b.q - a.q);

    for (const { tag } of ranges) {
      // Exact match
      if (locales[tag]) return tag;
      // Language-only match (drop region)
      const lang = tag.split('-')[0]!;
      if (locales[lang]) return lang;
      // Prefix match (en-US → en)
      const match = localeList.find((l) => l.toLowerCase() === lang);
      if (match) return match;
    }
    return null;
  };

  const detectLocale = (ctx: Context): string => {
    // 1. Query parameter wins
    const fromQuery = ctx.query(queryParam);
    if (fromQuery && locales[fromQuery]) return fromQuery;

    // 2. Cookie
    const fromCookie = ctx.cookie(cookieName);
    if (fromCookie && locales[fromCookie]) return fromCookie;

    // 3. Accept-Language header
    if (acceptHeader) {
      const header = ctx.header('accept-language');
      if (header) {
        const detected = detectFromAcceptHeader(header);
        if (detected) return detected;
      }
    }

    // 4. Default
    return defaultLocale;
  };

  const createT = (locale: string): TFunction => {
    const fn = ((key: string, values?: Record<string, unknown>) => translate(key, values, locale)) as TFunction;
    fn.locale = locale;
    return fn;
  };

  return {
    t(key, values, locale) {
      return translate(key, values, locale ?? defaultLocale);
    },
    detectLocale,
    createT,
    middleware() {
      return async (ctx, next) => {
        const locale = detectLocale(ctx);
        ctx.set('locale', locale);
        ctx.set('t', createT(locale));
        await next();
      };
    },
    addLocale(locale, tree) {
      locales[locale] = tree;
      if (!localeList.includes(locale)) localeList.push(locale);
    },
    getLocales() {
      return [...localeList];
    },
  };
}

/* ═════════════ INTERPOLATION ═════════════ */

export function interpolate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, rawKey) => {
    const key = rawKey.trim();
    const value = values[key];
    if (value === undefined || value === null) return `{${key}}`;
    return String(value);
  });
}

/* ═════════════ PLURAL CATEGORIES ═════════════ */

export function getPluralCategory(
  count: number,
  locale: string,
  customRules: Record<string, (n: number) => PluralCategory> = {},
): PluralCategory {
  const custom = customRules[locale] ?? customRules[locale.split('-')[0]!];
  if (custom) return custom(count);

  try {
    const rules = new Intl.PluralRules(locale);
    return rules.select(count) as PluralCategory;
  } catch {
    // Fallback for invalid locale codes: English plural rule
    return count === 1 ? 'one' : 'other';
  }
}

/* ═════════════ NUMBER + DATE FORMAT HELPERS ═════════════ */

export function formatNumber(n: number, locale: string, options: Intl.NumberFormatOptions = {}): string {
  try {
    return new Intl.NumberFormat(locale, options).format(n);
  } catch {
    return String(n);
  }
}

export function formatDate(d: Date | number, locale: string, options: Intl.DateTimeFormatOptions = {}): string {
  try {
    return new Intl.DateTimeFormat(locale, options).format(d);
  } catch {
    const dt = typeof d === 'number' ? new Date(d) : d;
    return dt.toISOString();
  }
}

export function formatCurrency(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}
