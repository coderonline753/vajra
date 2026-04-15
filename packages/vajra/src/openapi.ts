/**
 * Vajra OpenAPI / Swagger
 * Auto-generate OpenAPI 3.1 spec from route definitions.
 * Zod schemas → JSON Schema conversion built-in.
 * Swagger UI served from CDN (zero dependency).
 */

import type { Vajra } from './vajra';
import type { Handler } from './middleware';

/* ═══════ TYPES ═══════ */

interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
  contact?: { name?: string; email?: string; url?: string };
  license?: { name: string; url?: string };
}

interface OpenAPIRouteMetadata {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags?: string[];
  operationId?: string;
  deprecated?: boolean;
  security?: Array<Record<string, string[]>>;
  params?: unknown;
  query?: unknown;
  body?: unknown;
  response?: Record<number, unknown>;
}

interface OpenAPIOptions {
  /** API info */
  info: OpenAPIInfo;
  /** Path for the JSON spec. Default: /openapi.json */
  specPath?: string;
  /** Path for Swagger UI. Default: /docs */
  docsPath?: string;
  /** Server URLs */
  servers?: Array<{ url: string; description?: string }>;
  /** Global security schemes */
  securitySchemes?: Record<string, unknown>;
  /** Route metadata */
  routes?: OpenAPIRouteMetadata[];
}

/* ═══════ ZOD → JSON SCHEMA ═══════ */

function zodToJsonSchema(schema: any): Record<string, unknown> {
  if (!schema || !schema._def) return {};

  const def = schema._def;
  const typeName = def.typeName;

  switch (typeName) {
    case 'ZodString': {
      const result: Record<string, unknown> = { type: 'string' };
      for (const check of def.checks || []) {
        if (check.kind === 'min') result.minLength = check.value;
        if (check.kind === 'max') result.maxLength = check.value;
        if (check.kind === 'email') result.format = 'email';
        if (check.kind === 'url') result.format = 'uri';
        if (check.kind === 'uuid') result.format = 'uuid';
        if (check.kind === 'datetime') result.format = 'date-time';
        if (check.kind === 'regex') result.pattern = check.regex.source;
      }
      if (def.description) result.description = def.description;
      return result;
    }

    case 'ZodNumber': {
      const result: Record<string, unknown> = { type: 'number' };
      for (const check of def.checks || []) {
        if (check.kind === 'min') result[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
        if (check.kind === 'max') result[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
        if (check.kind === 'int') result.type = 'integer';
        if (check.kind === 'multipleOf') result.multipleOf = check.value;
      }
      if (def.description) result.description = def.description;
      return result;
    }

    case 'ZodBoolean':
      return { type: 'boolean', ...(def.description ? { description: def.description } : {}) };

    case 'ZodArray': {
      const result: Record<string, unknown> = { type: 'array', items: zodToJsonSchema(def.type) };
      if (def.minLength !== null) result.minItems = def.minLength.value;
      if (def.maxLength !== null) result.maxItems = def.maxLength.value;
      return result;
    }

    case 'ZodObject': {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      for (const [key, value] of Object.entries(shape || {})) {
        properties[key] = zodToJsonSchema(value);
        if ((value as any)?._def?.typeName !== 'ZodOptional' && (value as any)?._def?.typeName !== 'ZodDefault') {
          required.push(key);
        }
      }
      const result: Record<string, unknown> = { type: 'object', properties };
      if (required.length > 0) result.required = required;
      if (def.description) result.description = def.description;
      return result;
    }

    case 'ZodOptional':
      return zodToJsonSchema(def.innerType);

    case 'ZodNullable': {
      const inner = zodToJsonSchema(def.innerType);
      return { ...inner, nullable: true };
    }

    case 'ZodDefault':
      return { ...zodToJsonSchema(def.innerType), default: def.defaultValue() };

    case 'ZodEnum':
      return { type: 'string', enum: def.values };

    case 'ZodLiteral':
      return { type: typeof def.value, enum: [def.value] };

    case 'ZodUnion':
      return { oneOf: (def.options || []).map((o: any) => zodToJsonSchema(o)) };

    case 'ZodDiscriminatedUnion':
      return { oneOf: [...(def.options || []).values()].map((o: any) => zodToJsonSchema(o)) };

    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToJsonSchema(def.valueType) };

    case 'ZodDate':
      return { type: 'string', format: 'date-time' };

    case 'ZodAny':
      return {};

    case 'ZodUnknown':
      return {};

    case 'ZodVoid':
      return { type: 'null' };

    case 'ZodTuple':
      return {
        type: 'array',
        items: (def.items || []).map((i: any) => zodToJsonSchema(i)),
        minItems: def.items?.length,
        maxItems: def.items?.length,
      };

    default:
      return {};
  }
}

/* ═══════ SPEC GENERATION ═══════ */

function generateSpec(options: OpenAPIOptions): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const routes = options.routes || [];

  for (const route of routes) {
    // Convert Vajra :param to OpenAPI {param}
    const openApiPath = route.path.replace(/:(\w+)/g, '{$1}');

    if (!paths[openApiPath]) paths[openApiPath] = {};

    const operation: Record<string, unknown> = {
      summary: route.summary || '',
      description: route.description || '',
      tags: route.tags || [],
      deprecated: route.deprecated || false,
      parameters: [] as unknown[],
      responses: {} as Record<string, unknown>,
    };

    if (route.operationId) operation.operationId = route.operationId;

    // Path params
    if (route.params) {
      const shape = (route.params as any)?._def?.shape?.() || (route.params as any)?._def?.shape || {};
      for (const [name, schema] of Object.entries(shape)) {
        (operation.parameters as unknown[]).push({
          name, in: 'path', required: true,
          schema: zodToJsonSchema(schema),
        });
      }
    }

    // Query params
    if (route.query) {
      const shape = (route.query as any)?._def?.shape?.() || (route.query as any)?._def?.shape || {};
      for (const [name, schema] of Object.entries(shape)) {
        const isOptional = (schema as any)?._def?.typeName === 'ZodOptional';
        (operation.parameters as unknown[]).push({
          name, in: 'query', required: !isOptional,
          schema: zodToJsonSchema(schema),
        });
      }
    }

    // Request body
    if (route.body && ['POST', 'PUT', 'PATCH'].includes(route.method.toUpperCase())) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: zodToJsonSchema(route.body) } },
      };
    }

    // Responses
    if (route.response) {
      for (const [status, schema] of Object.entries(route.response)) {
        (operation.responses as Record<string, unknown>)[String(status)] = {
          description: status === '200' ? 'Success' : status === '201' ? 'Created' : 'Response',
          content: { 'application/json': { schema: zodToJsonSchema(schema) } },
        };
      }
    }
    if (!route.response || Object.keys(route.response).length === 0) {
      (operation.responses as Record<string, unknown>)['200'] = { description: 'Success' };
    }

    if (route.security) operation.security = route.security;

    paths[openApiPath][route.method.toLowerCase()] = operation;
  }

  const spec: Record<string, unknown> = {
    openapi: '3.1.0',
    info: options.info,
    paths,
  };

  if (options.servers) spec.servers = options.servers;
  if (options.securitySchemes) {
    spec.components = { securitySchemes: options.securitySchemes };
  }

  return spec;
}

/* ═══════ SWAGGER UI HTML ═══════ */

function swaggerHtml(title: string, specPath: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>body { margin: 0; } .swagger-ui .topbar { display: none; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '${specPath}',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      deepLinking: true,
    });
  </script>
</body>
</html>`;
}

/* ═══════ PUBLIC API ═══════ */

/**
 * Register OpenAPI spec + Swagger UI on a Vajra app.
 *
 * @example
 *   openapi(app, {
 *     info: { title: 'My API', version: '1.0.0' },
 *     routes: [
 *       { method: 'POST', path: '/users', body: CreateUserSchema, response: { 201: UserSchema }, tags: ['Users'] },
 *     ],
 *   });
 *   // GET /openapi.json — spec
 *   // GET /docs — Swagger UI
 */
export function openapi(app: Vajra, options: OpenAPIOptions): void {
  const specPath = options.specPath || '/openapi.json';
  const docsPath = options.docsPath || '/docs';

  // Cache spec (regenerate only on first request)
  let cachedSpec: string | null = null;

  app.get(specPath, (c) => {
    if (!cachedSpec) {
      cachedSpec = JSON.stringify(generateSpec(options));
    }
    c.setHeader('content-type', 'application/json');
    return c.text(cachedSpec);
  });

  app.get(docsPath, (c) => {
    return c.html(swaggerHtml(options.info.title, specPath));
  });
}

/** Export Zod converter for external use */
export { zodToJsonSchema };
