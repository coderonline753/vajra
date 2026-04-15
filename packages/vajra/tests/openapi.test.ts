import { describe, test, expect } from 'bun:test';
import { Vajra } from '../src/vajra';
import { openapi, zodToJsonSchema } from '../src/openapi';
import { z } from 'zod';

describe('zodToJsonSchema', () => {
  test('converts string schema', () => {
    const schema = zodToJsonSchema(z.string().min(2).max(100).email());
    expect(schema.type).toBe('string');
    expect(schema.minLength).toBe(2);
    expect(schema.maxLength).toBe(100);
    expect(schema.format).toBe('email');
  });

  test('converts number schema', () => {
    const schema = zodToJsonSchema(z.number().int().min(0).max(100));
    expect(schema.type).toBe('integer');
    expect(schema.minimum).toBe(0);
    expect(schema.maximum).toBe(100);
  });

  test('converts boolean schema', () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
  });

  test('converts array schema', () => {
    const schema = zodToJsonSchema(z.array(z.string()));
    expect(schema.type).toBe('array');
    expect((schema.items as any).type).toBe('string');
  });

  test('converts object schema with required fields', () => {
    const schema = zodToJsonSchema(z.object({
      name: z.string(),
      email: z.string().email(),
      age: z.number().optional(),
    }));
    expect(schema.type).toBe('object');
    expect((schema.properties as any).name.type).toBe('string');
    expect((schema.required as string[])).toContain('name');
    expect((schema.required as string[])).toContain('email');
    expect((schema.required as string[])).not.toContain('age');
  });

  test('converts enum schema', () => {
    const schema = zodToJsonSchema(z.enum(['admin', 'user', 'vendor']));
    expect(schema.type).toBe('string');
    expect(schema.enum).toEqual(['admin', 'user', 'vendor']);
  });

  test('converts nullable schema', () => {
    const schema = zodToJsonSchema(z.string().nullable());
    expect(schema.type).toBe('string');
    expect(schema.nullable).toBe(true);
  });

  test('converts default schema', () => {
    const schema = zodToJsonSchema(z.string().default('hello'));
    expect(schema.type).toBe('string');
    expect(schema.default).toBe('hello');
  });

  test('converts uuid format', () => {
    const schema = zodToJsonSchema(z.string().uuid());
    expect(schema.format).toBe('uuid');
  });

  test('converts union schema', () => {
    const schema = zodToJsonSchema(z.union([z.string(), z.number()]));
    expect(schema.oneOf).toHaveLength(2);
  });
});

describe('OpenAPI Integration', () => {
  test('serves OpenAPI spec at /openapi.json', async () => {
    const app = new Vajra();

    openapi(app, {
      info: { title: 'Test API', version: '1.0.0' },
      routes: [
        {
          method: 'GET',
          path: '/users',
          summary: 'List users',
          tags: ['Users'],
        },
      ],
    });

    const res = await app.handle(new Request('http://localhost/openapi.json'));
    expect(res.status).toBe(200);
    const spec = JSON.parse(await res.text());
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Test API');
    expect(spec.paths['/users'].get.summary).toBe('List users');
  });

  test('serves Swagger UI at /docs', async () => {
    const app = new Vajra();

    openapi(app, {
      info: { title: 'Test API', version: '1.0.0' },
    });

    const res = await app.handle(new Request('http://localhost/docs'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('swagger-ui');
    expect(html).toContain('/openapi.json');
  });

  test('converts path params from :param to {param}', async () => {
    const app = new Vajra();

    openapi(app, {
      info: { title: 'Test', version: '1.0.0' },
      routes: [
        { method: 'GET', path: '/users/:id/posts/:postId', summary: 'Get post' },
      ],
    });

    const res = await app.handle(new Request('http://localhost/openapi.json'));
    const spec = JSON.parse(await res.text());
    expect(spec.paths['/users/{id}/posts/{postId}']).toBeTruthy();
  });

  test('includes Zod body schema', async () => {
    const app = new Vajra();

    const CreateUser = z.object({
      name: z.string().min(2),
      email: z.string().email(),
    });

    openapi(app, {
      info: { title: 'Test', version: '1.0.0' },
      routes: [
        { method: 'POST', path: '/users', body: CreateUser, tags: ['Users'] },
      ],
    });

    const res = await app.handle(new Request('http://localhost/openapi.json'));
    const spec = JSON.parse(await res.text());
    const body = spec.paths['/users'].post.requestBody;
    expect(body.required).toBe(true);
    const schema = body.content['application/json'].schema;
    expect(schema.type).toBe('object');
    expect(schema.properties.name.type).toBe('string');
    expect(schema.properties.email.format).toBe('email');
  });

  test('includes response schemas', async () => {
    const app = new Vajra();

    const UserResponse = z.object({ id: z.string(), name: z.string() });

    openapi(app, {
      info: { title: 'Test', version: '1.0.0' },
      routes: [
        { method: 'GET', path: '/users/:id', response: { 200: UserResponse } },
      ],
    });

    const res = await app.handle(new Request('http://localhost/openapi.json'));
    const spec = JSON.parse(await res.text());
    const response = spec.paths['/users/{id}'].get.responses['200'];
    expect(response.content['application/json'].schema.type).toBe('object');
  });

  test('supports custom spec and docs paths', async () => {
    const app = new Vajra();

    openapi(app, {
      info: { title: 'Test', version: '1.0.0' },
      specPath: '/api/spec.json',
      docsPath: '/api/docs',
    });

    const specRes = await app.handle(new Request('http://localhost/api/spec.json'));
    expect(specRes.status).toBe(200);

    const docsRes = await app.handle(new Request('http://localhost/api/docs'));
    expect(docsRes.status).toBe(200);
  });
});
