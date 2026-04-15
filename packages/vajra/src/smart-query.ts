/**
 * Vajra Smart Query — GraphQL features on REST
 * Field selection, relation embedding, filtering, sorting.
 * "Roti maango toh sirf roti aaye, poori thali nahi."
 *
 * @example
 *   GET /api/users?fields=name,email&include=posts&filter[role]=admin&sort=-created_at&per_page=10
 */

import type { Middleware } from './middleware';
import type { Context } from './context';

/* ═══════ TYPES ═══════ */

interface FieldConfig {
  /** Can user request this field via ?fields= */
  selectable: boolean;
  /** Never expose in response (passwords, secrets) */
  hidden: boolean;
  /** Include when no ?fields= specified */
  defaultSelect: boolean;
}

interface RelationConfig {
  /** Target table name */
  table: string;
  /** Relation type */
  type: 'hasMany' | 'belongsTo' | 'hasOne';
  /** Foreign key column */
  foreignKey: string;
  /** Local key column. Default: 'id' */
  localKey?: string;
  /** Can user ?include= this relation */
  includable: boolean;
  /** Nested resource definition for nested field selection */
  resource?: ResourceDefinition;
}

export interface ResourceDefinition {
  /** Table name */
  table: string;
  /** Field configuration */
  fields: Record<string, FieldConfig>;
  /** Relation configuration */
  relations?: Record<string, RelationConfig>;
}

interface ParsedSmartQuery {
  fields: string[];
  includes: ParsedInclude[];
  filters: ParsedFilter[];
  sort: ParsedSort[];
  page: number;
  pageSize: number;
}

interface ParsedInclude {
  path: string;
  segments: string[];
}

interface ParsedFilter {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

interface ParsedSort {
  column: string;
  direction: 'ASC' | 'DESC';
}

type FilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'like' | 'between' | 'isnull';

interface SmartQueryOptions {
  /** Resource definition */
  resource: ResourceDefinition;
  /** Default page size. Default: 25 */
  defaultPageSize?: number;
  /** Max page size. Default: 100 */
  maxPageSize?: number;
  /** Max include depth. Default: 3 */
  maxDepth?: number;
  /** Max includes per request. Default: 5 */
  maxIncludes?: number;
  /** Max filters per request. Default: 20 */
  maxFilters?: number;
  /** Max sort fields. Default: 3 */
  maxSortFields?: number;
}

/* ═══════ RESOURCE BUILDER ═══════ */

/**
 * Define a resource with field visibility and relations.
 *
 * @example
 *   const userResource = defineResource({
 *     table: 'users',
 *     fields: {
 *       id: { selectable: true, hidden: false, defaultSelect: true },
 *       name: { selectable: true, hidden: false, defaultSelect: true },
 *       email: { selectable: true, hidden: false, defaultSelect: true },
 *       password: { selectable: false, hidden: true, defaultSelect: false },
 *     },
 *     relations: {
 *       posts: { table: 'posts', type: 'hasMany', foreignKey: 'author_id', includable: true },
 *     },
 *   });
 */
export function defineResource(def: ResourceDefinition): ResourceDefinition {
  return def;
}

/* ═══════ PARSERS ═══════ */

function parseFields(param: string | null, resource: ResourceDefinition): string[] {
  if (!param) {
    return Object.entries(resource.fields)
      .filter(([_, cfg]) => cfg.defaultSelect && !cfg.hidden)
      .map(([name]) => name);
  }

  const requested = param.split(',').map(f => f.trim()).slice(0, 50);
  const validated: string[] = [];

  for (const field of requested) {
    if (resource.fields[field]?.selectable && !resource.fields[field]?.hidden) {
      validated.push(field);
    }
  }

  // Always include primary key
  if (!validated.includes('id') && resource.fields['id']) {
    validated.unshift('id');
  }

  return validated.length > 0 ? validated : ['id'];
}

function parseIncludes(
  param: string | null,
  resource: ResourceDefinition,
  maxDepth: number,
  maxIncludes: number
): ParsedInclude[] {
  if (!param || !resource.relations) return [];

  const paths = param.split(',').map(p => p.trim()).slice(0, maxIncludes);
  const validated: ParsedInclude[] = [];

  for (const path of paths) {
    const segments = path.split('.');

    if (segments.length > maxDepth) continue;

    // Validate each segment is an includable relation
    let valid = true;
    let currentResource = resource;

    for (const segment of segments) {
      const relation = currentResource.relations?.[segment];
      if (!relation || !relation.includable) {
        valid = false;
        break;
      }
      if (relation.resource) {
        currentResource = relation.resource;
      }
    }

    if (valid) validated.push({ path, segments });
  }

  return validated;
}

function parseFilters(
  query: Record<string, string>,
  resource: ResourceDefinition,
  maxFilters: number
): ParsedFilter[] {
  const filters: ParsedFilter[] = [];

  for (const [key, value] of Object.entries(query)) {
    if (filters.length >= maxFilters) break;

    const match = key.match(/^filter\[(\w+)\](?:\[(\w+)\])?$/);
    if (!match) continue;

    const [, field, op] = match;
    const operator = (op || 'eq') as FilterOperator;

    if (!resource.fields[field]?.selectable) continue;

    const validOps: FilterOperator[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'like', 'between', 'isnull'];
    if (!validOps.includes(operator)) continue;

    filters.push({ field, operator, value: castValue(value, operator) });
  }

  return filters;
}

function castValue(value: string, operator: FilterOperator): unknown {
  if (operator === 'in') return value.split(',');
  if (operator === 'between') return value.split(',').slice(0, 2);
  if (operator === 'isnull') return value === 'true';
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  return value;
}

function parseSort(
  param: string | null,
  resource: ResourceDefinition,
  maxFields: number
): ParsedSort[] {
  if (!param) return [{ column: 'id', direction: 'ASC' }];

  const fields = param.split(',').slice(0, maxFields);
  const result: ParsedSort[] = [];

  for (const field of fields) {
    const desc = field.startsWith('-');
    const name = desc ? field.slice(1) : field;
    if (!resource.fields[name]?.selectable) continue;
    result.push({ column: name, direction: desc ? 'DESC' : 'ASC' });
  }

  return result.length > 0 ? result : [{ column: 'id', direction: 'ASC' }];
}

/* ═══════ SQL BUILDERS ═══════ */

/**
 * Build WHERE clause from parsed filters.
 * Returns parameterized SQL (safe from injection).
 */
export function filtersToSQL(filters: ParsedFilter[]): { clause: string; values: unknown[] } {
  if (filters.length === 0) return { clause: '1=1', values: [] };

  const clauses: string[] = [];
  const values: unknown[] = [];

  for (const f of filters) {
    const col = `"${f.field}"`;

    switch (f.operator) {
      case 'eq': clauses.push(`${col} = ?`); values.push(f.value); break;
      case 'ne': clauses.push(`${col} != ?`); values.push(f.value); break;
      case 'gt': clauses.push(`${col} > ?`); values.push(f.value); break;
      case 'gte': clauses.push(`${col} >= ?`); values.push(f.value); break;
      case 'lt': clauses.push(`${col} < ?`); values.push(f.value); break;
      case 'lte': clauses.push(`${col} <= ?`); values.push(f.value); break;
      case 'in': {
        const arr = f.value as unknown[];
        clauses.push(`${col} IN (${arr.map(() => '?').join(', ')})`);
        values.push(...arr);
        break;
      }
      case 'like': {
        clauses.push(`${col} LIKE ?`);
        const escaped = String(f.value).replace(/[%_]/g, '\\$&');
        values.push(`%${escaped}%`);
        break;
      }
      case 'between': {
        const [min, max] = f.value as unknown[];
        clauses.push(`${col} BETWEEN ? AND ?`);
        values.push(min, max);
        break;
      }
      case 'isnull':
        clauses.push(f.value ? `${col} IS NULL` : `${col} IS NOT NULL`);
        break;
    }
  }

  return { clause: clauses.join(' AND '), values };
}

/* ═══════ MIDDLEWARE ═══════ */

/**
 * Smart Query middleware. Parses and validates query params, stores on context.
 *
 * @example
 *   app.get('/api/users', smartQuery({ resource: userResource }), async (c) => {
 *     const sq = c.get<ParsedSmartQuery>('smartQuery');
 *     // Use sq.fields, sq.filters, sq.sort, sq.page, sq.pageSize, sq.includes
 *   });
 */
export function smartQuery(options: SmartQueryOptions): Middleware {
  const {
    resource,
    defaultPageSize = 25,
    maxPageSize = 100,
    maxDepth = 3,
    maxIncludes = 5,
    maxFilters = 20,
    maxSortFields = 3,
  } = options;

  return async (c: Context, next) => {
    const sq: ParsedSmartQuery = {
      fields: parseFields(c.query('fields'), resource),
      includes: parseIncludes(c.query('include'), resource, maxDepth, maxIncludes),
      filters: parseFilters(c.queries, resource, maxFilters),
      sort: parseSort(c.query('sort'), resource, maxSortFields),
      page: Math.max(1, parseInt(c.query('page') || '1', 10)),
      pageSize: Math.min(maxPageSize, Math.max(1, parseInt(c.query('per_page') || String(defaultPageSize), 10))),
    };

    c.set('smartQuery', sq);
    return next();
  };
}

/**
 * Serialize a row through the resource definition.
 * Strips hidden fields even if they somehow got into the result.
 */
export function serializeRow(
  row: Record<string, unknown>,
  resource: ResourceDefinition,
  fields?: string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const allowedFields = fields || Object.keys(resource.fields);

  for (const key of allowedFields) {
    if (resource.fields[key] && !resource.fields[key].hidden && key in row) {
      result[key] = row[key];
    }
  }

  return result;
}

export type { ParsedSmartQuery, ParsedFilter, ParsedSort, ParsedInclude, SmartQueryOptions, FilterOperator, FieldConfig, RelationConfig };
