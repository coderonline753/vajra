/**
 * Vajra Config System
 * Typed configuration with Zod validation, env var loading, defaults.
 *
 * @example
 *   const config = defineConfig({
 *     port: z.coerce.number().default(3000),
 *     database: z.object({
 *       url: z.string().url(),
 *       pool: z.coerce.number().default(10),
 *     }),
 *     jwt: z.object({
 *       secret: z.string().min(32),
 *       expiresIn: z.string().default('15m'),
 *     }),
 *   });
 *
 *   console.log(config.port);        // 3000
 *   console.log(config.database.url); // from DATABASE_URL env var
 */

import { z, type ZodObject, type ZodRawShape } from 'zod';

/**
 * Define typed configuration from Zod schema.
 * Automatically reads from environment variables.
 *
 * Env var naming: nested keys use underscore + uppercase.
 * `database.url` → `DATABASE_URL`
 * `jwt.secret` → `JWT_SECRET`
 * `port` → `PORT`
 */
export function defineConfig<T extends ZodRawShape>(
  schema: T,
  options?: {
    /** Custom env prefix. e.g. 'APP_' makes PORT → APP_PORT */
    prefix?: string;
    /** Custom env source (default: process.env) */
    env?: Record<string, string | undefined>;
    /** .env file path to load */
    envFile?: string;
  }
): z.infer<ZodObject<T>> {
  const prefix = options?.prefix || '';
  const envSource = options?.env || process.env;

  // Build env-derived object
  const envData = buildFromEnv(schema, envSource, prefix);

  // Parse with Zod (validates + applies defaults)
  const zodSchema = z.object(schema);
  const result = zodSchema.safeParse(envData);

  if (!result.success) {
    const errors = result.error.issues.map(i =>
      `  ${i.path.join('.')}: ${i.message}`
    ).join('\n');
    throw new Error(`[Vajra Config] Validation failed:\n${errors}`);
  }

  return result.data;
}

/**
 * Build a nested object from flat env vars.
 * PORT=3000 → { port: 3000 }
 * DATABASE_URL=... → { database: { url: ... } }
 */
function buildFromEnv(
  schema: ZodRawShape,
  env: Record<string, string | undefined>,
  prefix: string,
  path: string[] = []
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, zodType] of Object.entries(schema)) {
    const envKey = prefix + [...path, key].join('_').toUpperCase();

    // Check if this is a nested object
    const innerDef = (zodType as any)?._def;

    if (innerDef?.typeName === 'ZodObject') {
      const innerShape = typeof innerDef.shape === 'function' ? innerDef.shape() : innerDef.shape;
      result[key] = buildFromEnv(innerShape, env, prefix, [...path, key]);
    } else {
      // Read from env
      const envValue = env[envKey];
      if (envValue !== undefined) {
        result[key] = envValue;
      }
      // If not in env, Zod defaults will handle it
    }
  }

  return result;
}

/**
 * Get a single env var with type coercion and optional default.
 * Simpler alternative to defineConfig for quick env reads.
 */
export function env(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`[Vajra Config] Missing required env var: ${key}`);
  }
  return value;
}

export function envNumber(key: string, defaultValue?: number): number {
  const raw = process.env[key];
  if (raw === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`[Vajra Config] Missing required env var: ${key}`);
  }
  const num = Number(raw);
  if (isNaN(num)) throw new Error(`[Vajra Config] ${key} is not a valid number: ${raw}`);
  return num;
}

export function envBool(key: string, defaultValue?: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`[Vajra Config] Missing required env var: ${key}`);
  }
  return raw === 'true' || raw === '1' || raw === 'yes';
}
