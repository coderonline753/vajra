/**
 * Vajra — Indestructible. Lightning Fast.
 * Batteries-included TypeScript backend framework.
 */

export { Vajra } from './vajra';
export type { VajraOptions } from './vajra';
export { Context } from './context';
export {
  VajraError, HttpError,
  NotFoundError, ConstraintError, ConnectionError, QueryTimeoutError,
  BusinessError, PermissionError, RateLimitError, ExternalServiceError, ConflictError,
  ValidationError, AuthError, PayloadTooLargeError,
  type VajraErrorOptions,
} from './errors';
export { Router } from './router';
export { validate } from './validator';
export { cors, logger, timing, secureHeaders } from './middleware';
export type { Handler, Middleware, Next } from './middleware';
export { serveStatic } from './static';
export { parseCookies, serializeCookie } from './cookie';
export type { CookieOptions } from './cookie';
export { rateLimit, tokenBucket, createRedisStore, type RateLimitStore, type TokenBucketStore, type RedisStoreOptions } from './rate-limiter';
export { jwt, jwtSign, jwtVerify } from './jwt';
export type { WebSocketHandler, WebSocketData } from './websocket';
export * from './security';
export * from './enterprise';
export * from './ai';
export * from './modules';
export { definePlugin, type PluginDefinition } from './plugin';
export { openapi, zodToJsonSchema } from './openapi';
export { createMailer, emailTemplate, type SMTPConfig, type EmailMessage, type SendResult } from './email';
export { createScheduler, type CronJob, type SchedulerOptions } from './cron';
export { imageProcessor, generateSrcset, getImageMetadata, detectFormat, type ImageProcessorOptions, type TransformParams } from './image';
export { videoStreamer, detectGPU, getVideoMetadata, extractThumbnail, srtToVtt, DEFAULT_LADDER, type VideoStreamerOptions, type VideoMetadata, type TranscodeJob } from './video';
export { createDatabase, createLoader, createMigrationRunner, table, column, generateCreateTableSQL, type DatabaseConfig, type TableSchema, type ColumnDef, type QueryResult, type MigrationFile, type MigrationRunnerOptions } from './data';
export { createBenchmark, httpBenchmark, printHttpResult, type BenchmarkResult, type BenchmarkOptions } from './benchmark';
export { contextStorage, getRequestContext, setRequestContext, getRequestContextAll, hasRequestContext } from './context-storage';
export { createLogger, requestLogger, type Logger, type LoggerOptions, type LogLevel } from './logger';
export { defineConfig, env, envNumber, envBool } from './config';
export { createFeatureFlags, type FeatureFlags, type FlagConfig } from './feature-flags';
export { smartQuery, defineResource, filtersToSQL, serializeRow, type ResourceDefinition, type ParsedSmartQuery, type SmartQueryOptions } from './smart-query';
export { cluster, ClusterManager, generateNginxUpstream, generateSystemdService, type ClusterOptions, type NginxUpstreamOptions } from './cluster';
export * from './ssr';
