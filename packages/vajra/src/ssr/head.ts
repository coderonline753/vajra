/**
 * Vajra Head Manager
 * Manages <head> tags: title, meta, OG, structured data.
 * Resolves BEFORE streaming starts (SEO + social crawler requirement).
 */

export interface HeadData {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  openGraph?: {
    title?: string;
    description?: string;
    image?: string;
    url?: string;
    type?: string;
    siteName?: string;
    locale?: string;
    [key: string]: string | undefined;
  };
  twitter?: {
    card?: 'summary' | 'summary_large_image' | 'app' | 'player';
    site?: string;
    creator?: string;
    title?: string;
    description?: string;
    image?: string;
  };
  structuredData?: Record<string, unknown> | Record<string, unknown>[];
  links?: Array<{ rel: string; href: string; [key: string]: string }>;
  scripts?: Array<{ src?: string; type?: string; content?: string; defer?: boolean; async?: boolean }>;
  styles?: Array<{ href?: string; content?: string }>;
  extra?: string[];
}

/**
 * Render HeadData to HTML string for injection into <head>.
 */
export function renderHead(head: HeadData): string {
  const tags: string[] = [];

  if (head.title) {
    tags.push(`<title>${escapeForHead(head.title)}</title>`);
  }

  if (head.description) {
    tags.push(`<meta name="description" content="${escapeForHead(head.description)}" />`);
  }

  if (head.canonical) {
    tags.push(`<link rel="canonical" href="${escapeForHead(head.canonical)}" />`);
  }

  if (head.robots) {
    tags.push(`<meta name="robots" content="${escapeForHead(head.robots)}" />`);
  }

  // Open Graph
  if (head.openGraph) {
    for (const [key, value] of Object.entries(head.openGraph)) {
      if (value) {
        tags.push(`<meta property="og:${key}" content="${escapeForHead(value)}" />`);
      }
    }
  }

  // Twitter Card
  if (head.twitter) {
    for (const [key, value] of Object.entries(head.twitter)) {
      if (value) {
        tags.push(`<meta name="twitter:${key}" content="${escapeForHead(value)}" />`);
      }
    }
  }

  // Structured Data (JSON-LD)
  if (head.structuredData) {
    const data = Array.isArray(head.structuredData) ? head.structuredData : [head.structuredData];
    for (const item of data) {
      const ld = { '@context': 'https://schema.org', ...item };
      tags.push(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
    }
  }

  // Additional links
  if (head.links) {
    for (const link of head.links) {
      const attrs = Object.entries(link).map(([k, v]) => `${k}="${escapeForHead(v)}"`).join(' ');
      tags.push(`<link ${attrs} />`);
    }
  }

  // Additional styles
  if (head.styles) {
    for (const style of head.styles) {
      if (style.href) {
        tags.push(`<link rel="stylesheet" href="${escapeForHead(style.href)}" />`);
      } else if (style.content) {
        tags.push(`<style>${style.content}</style>`);
      }
    }
  }

  // Additional scripts
  if (head.scripts) {
    for (const script of head.scripts) {
      if (script.src) {
        const attrs = [`src="${escapeForHead(script.src)}"`];
        if (script.type) attrs.push(`type="${script.type}"`);
        if (script.defer) attrs.push('defer');
        if (script.async) attrs.push('async');
        tags.push(`<script ${attrs.join(' ')}></script>`);
      } else if (script.content) {
        const type = script.type ? ` type="${script.type}"` : '';
        tags.push(`<script${type}>${script.content}</script>`);
      }
    }
  }

  // Extra raw tags
  if (head.extra) {
    tags.push(...head.extra);
  }

  return tags.join('\n    ');
}

function escapeForHead(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
