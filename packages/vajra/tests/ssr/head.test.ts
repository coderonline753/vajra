import { describe, test, expect } from 'bun:test';
import { renderHead } from '../../src/ssr/head';

describe('renderHead', () => {
  test('renders title', () => {
    const html = renderHead({ title: 'My Page' });
    expect(html).toContain('<title>My Page</title>');
  });

  test('renders description', () => {
    const html = renderHead({ description: 'A great page' });
    expect(html).toContain('<meta name="description" content="A great page" />');
  });

  test('renders canonical', () => {
    const html = renderHead({ canonical: 'https://vajra.run/docs' });
    expect(html).toContain('<link rel="canonical" href="https://vajra.run/docs" />');
  });

  test('renders Open Graph tags', () => {
    const html = renderHead({
      openGraph: { title: 'OG Title', image: '/og.png', type: 'website' }
    });
    expect(html).toContain('property="og:title" content="OG Title"');
    expect(html).toContain('property="og:image" content="/og.png"');
    expect(html).toContain('property="og:type" content="website"');
  });

  test('renders Twitter Card tags', () => {
    const html = renderHead({
      twitter: { card: 'summary_large_image', site: '@vajrajs' }
    });
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('name="twitter:site" content="@vajrajs"');
  });

  test('renders structured data', () => {
    const html = renderHead({
      structuredData: { '@type': 'Product', name: 'Vajra', offers: { price: '0' } }
    });
    expect(html).toContain('application/ld+json');
    expect(html).toContain('"@context":"https://schema.org"');
    expect(html).toContain('"@type":"Product"');
  });

  test('renders additional links', () => {
    const html = renderHead({
      links: [{ rel: 'icon', href: '/favicon.svg' }]
    });
    expect(html).toContain('rel="icon" href="/favicon.svg"');
  });

  test('renders stylesheets', () => {
    const html = renderHead({
      styles: [{ href: '/style.css' }]
    });
    expect(html).toContain('rel="stylesheet" href="/style.css"');
  });

  test('renders inline styles', () => {
    const html = renderHead({
      styles: [{ content: 'body { margin: 0 }' }]
    });
    expect(html).toContain('<style>body { margin: 0 }</style>');
  });

  test('escapes HTML in title', () => {
    const html = renderHead({ title: '<script>alert("xss")</script>' });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  test('renders complete head with all fields', () => {
    const html = renderHead({
      title: 'Vajra Framework',
      description: 'Lightning fast',
      canonical: 'https://vajra.run',
      openGraph: { title: 'Vajra', type: 'website' },
      twitter: { card: 'summary' },
    });
    expect(html).toContain('<title>Vajra Framework</title>');
    expect(html).toContain('og:title');
    expect(html).toContain('twitter:card');
  });
});
