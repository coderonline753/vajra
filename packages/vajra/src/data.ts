/**
 * Vajra Data — Lightweight typed query layer + schema toolkit
 * SQL-first, multi-database (SQLite dev, PostgreSQL prod).
 * Not a full ORM. No Active Record. No magic.
 *
 * @example
 *   const db = createDatabase({ driver: 'sqlite', path: './dev.db' });
 *   const users = await db.query('SELECT * FROM users WHERE role = ?', ['admin']);
 */

/* ═══════ IDENTIFIER SAFETY ═══════ */

/** Simple identifier: column, table. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Qualified identifier: table.column (used in select + orderBy + join ON). */
const QUALIFIED_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function assertIdent(name: string, context: string): string {
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
    throw new Error(`[Vajra Data] Invalid identifier in ${context}: ${JSON.stringify(name)}`);
  }
  return name;
}

function assertQualifiedIdent(name: string, context: string): string {
  if (typeof name !== 'string' || !QUALIFIED_IDENTIFIER_RE.test(name)) {
    throw new Error(`[Vajra Data] Invalid identifier in ${context}: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Quote a validated identifier. For `a.b` produces `"a"."b"`. */
function quoteIdent(name: string): string {
  if (name.includes('.')) {
    const [t, c] = name.split('.');
    return `"${t}"."${c}"`;
  }
  return `"${name}"`;
}

/* ═══════ TYPES ═══════ */

type ColumnType = 'text' | 'integer' | 'real' | 'boolean' | 'timestamp' | 'uuid' | 'json' | 'serial';

interface ColumnDef {
  type: ColumnType;
  primaryKey?: boolean;
  unique?: boolean;
  notNull?: boolean;
  default?: string | number | boolean | null;
  references?: { table: string; column: string; onDelete?: 'cascade' | 'set null' | 'restrict' };
}

interface TableSchema {
  name: string;
  columns: Record<string, ColumnDef>;
}

interface DatabaseConfig {
  driver: 'sqlite' | 'postgres';
  /** SQLite file path */
  path?: string;
  /** PostgreSQL connection URL */
  url?: string;
  /** Connection pool size (PostgreSQL only) */
  poolSize?: number;
}

interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

interface MigrationFile {
  name: string;
  up: (db: Database) => Promise<void>;
  down: (db: Database) => Promise<void>;
}

/* ═══════ SCHEMA BUILDER ═══════ */

function col(type: ColumnType): ColumnDef {
  return { type };
}

export const column = {
  text: () => col('text'),
  integer: () => col('integer'),
  real: () => col('real'),
  boolean: () => col('boolean'),
  timestamp: () => col('timestamp'),
  uuid: () => col('uuid'),
  json: () => col('json'),
  serial: () => col('serial'),
};

// Chain methods on ColumnDef
const chainMethods = {
  primaryKey() { this.primaryKey = true; return this; },
  unique() { this.unique = true; return this; },
  notNull() { this.notNull = true; return this; },
  default(val: string | number | boolean | null) { this.default = val; return this; },
  references(table: string, column = 'id', opts?: { onDelete?: 'cascade' | 'set null' | 'restrict' }) {
    this.references = { table, column, onDelete: opts?.onDelete };
    return this;
  },
};

// Inject chain methods into column builders
for (const [key, fn] of Object.entries(column)) {
  const original = fn;
  (column as any)[key] = () => {
    const def = original();
    return Object.assign(def, chainMethods);
  };
}

/**
 * Define a table schema.
 */
export function table(name: string, columns: Record<string, ColumnDef>): TableSchema {
  return { name, columns };
}

/* ═══════ SQL GENERATION ═══════ */

function columnTypeToSQL(col: ColumnDef, driver: 'sqlite' | 'postgres'): string {
  const typeMap: Record<string, Record<ColumnType, string>> = {
    sqlite: {
      text: 'TEXT', integer: 'INTEGER', real: 'REAL', boolean: 'INTEGER',
      timestamp: 'TEXT', uuid: 'TEXT', json: 'TEXT', serial: 'INTEGER',
    },
    postgres: {
      text: 'TEXT', integer: 'INTEGER', real: 'DOUBLE PRECISION', boolean: 'BOOLEAN',
      timestamp: 'TIMESTAMPTZ', uuid: 'UUID', json: 'JSONB', serial: 'SERIAL',
    },
  };

  let sql = typeMap[driver][col.type];

  if (col.primaryKey) {
    sql += ' PRIMARY KEY';
    if (col.type === 'serial' && driver === 'sqlite') sql = 'INTEGER PRIMARY KEY AUTOINCREMENT';
  }
  if (col.unique) sql += ' UNIQUE';
  if (col.notNull) sql += ' NOT NULL';
  if (col.default !== undefined) {
    if (typeof col.default === 'string') {
      // Check if it's a SQL function like now() or gen_random_uuid()
      if (col.default.includes('(')) {
        sql += ` DEFAULT ${driver === 'sqlite' && col.default === 'now()' ? "datetime('now')" : col.default}`;
      } else {
        sql += ` DEFAULT '${col.default}'`;
      }
    } else if (col.default === null) {
      sql += ' DEFAULT NULL';
    } else if (typeof col.default === 'boolean') {
      sql += ` DEFAULT ${col.default ? 1 : 0}`;
    } else {
      sql += ` DEFAULT ${col.default}`;
    }
  }

  return sql;
}

function generateCreateTableSQL(schema: TableSchema, driver: 'sqlite' | 'postgres'): string {
  const cols = Object.entries(schema.columns).map(([name, def]) => {
    let line = `  "${name}" ${columnTypeToSQL(def, driver)}`;
    if (def.references) {
      line += ` REFERENCES "${def.references.table}"("${def.references.column}")`;
      if (def.references.onDelete) line += ` ON DELETE ${def.references.onDelete.toUpperCase()}`;
    }
    return line;
  });

  return `CREATE TABLE IF NOT EXISTS "${schema.name}" (\n${cols.join(',\n')}\n);`;
}

/* ═══════ QUERY BUILDER ═══════ */

class QueryBuilder<T = Record<string, unknown>> {
  private _table: string;
  private _select = '*';
  private _where: Array<{ clause: string; values: unknown[] }> = [];
  private _orderBy: string[] = [];
  private _limit?: number;
  private _offset?: number;
  private _joins: string[] = [];
  private db: Database;

  constructor(db: Database, tableName: string) {
    this.db = db;
    this._table = tableName;
  }

  /** Safe column selection. Each name must be a valid identifier or `*`. */
  select(...columns: string[]): this {
    if (columns.length === 0) return this;
    this._select = columns
      .map(c => c === '*' ? '*' : quoteIdent(assertQualifiedIdent(c, 'select')))
      .join(', ');
    return this;
  }

  /** Raw SELECT expression (escape hatch for aggregates, CASE, functions). Caller is responsible for safety. */
  selectRaw(expression: string): this {
    this._select = expression;
    return this;
  }

  where(conditions: Record<string, unknown>): this {
    for (const [rawKey, value] of Object.entries(conditions)) {
      const key = assertIdent(rawKey, 'where');
      if (value === null) {
        this._where.push({ clause: `${quoteIdent(key)} IS NULL`, values: [] });
      } else if (Array.isArray(value)) {
        const placeholders = value.map(() => '?').join(', ');
        this._where.push({ clause: `${quoteIdent(key)} IN (${placeholders})`, values: value });
      } else {
        this._where.push({ clause: `${quoteIdent(key)} = ?`, values: [value] });
      }
    }
    return this;
  }

  /** Raw WHERE clause with ? placeholders and parameter array. */
  whereRaw(clause: string, values: unknown[] = []): this {
    this._where.push({ clause, values });
    return this;
  }

  orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): this {
    const dir = direction === 'asc' || direction === 'desc' ? direction : 'asc';
    this._orderBy.push(`${quoteIdent(assertQualifiedIdent(column, 'orderBy'))} ${dir.toUpperCase()}`);
    return this;
  }

  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) throw new Error(`[Vajra Data] limit must be a non-negative integer, got ${n}`);
    this._limit = n;
    return this;
  }

  offset(n: number): this {
    if (!Number.isInteger(n) || n < 0) throw new Error(`[Vajra Data] offset must be a non-negative integer, got ${n}`);
    this._offset = n;
    return this;
  }

  /**
   * Join another table. `on` accepts either a structured pair {left, right}
   * (both validated as qualified identifiers) or a raw SQL string (escape hatch).
   */
  join(table: string, on: string | { left: string; right: string }): this {
    this._joins.push(this.buildJoin('JOIN', table, on));
    return this;
  }

  leftJoin(table: string, on: string | { left: string; right: string }): this {
    this._joins.push(this.buildJoin('LEFT JOIN', table, on));
    return this;
  }

  /** Raw JOIN expression. Caller is responsible for safety. */
  joinRaw(expression: string): this {
    this._joins.push(expression);
    return this;
  }

  private buildJoin(kind: string, table: string, on: string | { left: string; right: string }): string {
    const safeTable = quoteIdent(assertIdent(table, 'join table'));
    if (typeof on === 'object' && on !== null) {
      const left = quoteIdent(assertQualifiedIdent(on.left, 'join on.left'));
      const right = quoteIdent(assertQualifiedIdent(on.right, 'join on.right'));
      return `${kind} ${safeTable} ON ${left} = ${right}`;
    }
    return `${kind} ${safeTable} ON ${on}`;
  }

  async execute(): Promise<T[]> {
    let sql = `SELECT ${this._select} FROM ${quoteIdent(this._table)}`;

    if (this._joins.length > 0) sql += ' ' + this._joins.join(' ');

    const values: unknown[] = [];
    if (this._where.length > 0) {
      const clauses = this._where.map(w => {
        values.push(...w.values);
        return w.clause;
      });
      sql += ' WHERE ' + clauses.join(' AND ');
    }

    if (this._orderBy.length > 0) sql += ' ORDER BY ' + this._orderBy.join(', ');
    if (this._limit !== undefined) sql += ` LIMIT ${this._limit}`;
    if (this._offset !== undefined) sql += ` OFFSET ${this._offset}`;

    const result = await this.db.query<T>(sql, values);
    return result.rows;
  }

  async first(): Promise<T | null> {
    this._limit = 1;
    const rows = await this.execute();
    return rows[0] || null;
  }

  async count(): Promise<number> {
    this.selectRaw('COUNT(*) as count');
    const rows = await this.execute();
    const firstRow = rows[0] as { count?: number | string } | undefined;
    return Number(firstRow?.count ?? 0) || 0;
  }
}

/* ═══════ DATABASE CLASS ═══════ */

interface SqliteLike {
  prepare(sql: string): { all(...values: unknown[]): unknown[]; run(...values: unknown[]): { changes: number } };
  exec(sql: string): void;
  close(): void;
}

interface PgClientLike {
  unsafe(sql: string, values: unknown[]): Promise<unknown[]>;
  end(): Promise<void>;
}

class Database {
  private config: DatabaseConfig;
  private sqliteDb: SqliteLike | null = null;
  private pgClient: PgClientLike | null = null;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.config.driver === 'sqlite') {
      const { Database: SQLiteDB } = await import('bun:sqlite');
      this.sqliteDb = new SQLiteDB(this.config.path || ':memory:');
      this.sqliteDb.exec('PRAGMA journal_mode = WAL');
      this.sqliteDb.exec('PRAGMA foreign_keys = ON');
    } else if (this.config.driver === 'postgres') {
      const pg = await import('postgres');
      this.pgClient = (pg.default || pg)(this.config.url!, {
        max: this.config.poolSize || 10,
        idle_timeout: 30,
        connect_timeout: 10,
      });
    }
  }

  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    if (this.config.driver === 'sqlite') {
      if (!this.sqliteDb) await this.connect();

      const stmt = this.sqliteDb!.prepare(sql);
      const isSelect = sql.trim().toUpperCase().startsWith('SELECT');

      if (isSelect) {
        const rows = stmt.all(...values) as T[];
        return { rows, rowCount: rows.length };
      } else {
        const result = stmt.run(...values);
        return { rows: [] as T[], rowCount: result.changes };
      }
    }

    // PostgreSQL (reuse connection pool)
    if (this.config.driver === 'postgres') {
      if (!this.pgClient) await this.connect();

      let paramIndex = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++paramIndex}`);

      const result = await this.pgClient!.unsafe(pgSql, values);
      return { rows: result as T[], rowCount: result.length };
    }

    throw new Error(`Unsupported driver: ${this.config.driver}`);
  }

  /** Typed query builder */
  from<T = Record<string, unknown>>(tableName: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this, assertIdent(tableName, 'from'));
  }

  /**
   * Insert row(s).
   *
   * @param returning PostgreSQL only. Columns to return from the inserted row(s).
   *                  Pass '*' to return the full row. Ignored on SQLite (which does
   *                  not support RETURNING through bun:sqlite query(); use raw() if needed).
   */
  async insert<T = Record<string, unknown>>(
    tableName: string,
    data: Record<string, unknown> | Record<string, unknown>[],
    options?: { returning?: '*' | string[] }
  ): Promise<QueryResult<T>> {
    const safeTable = assertIdent(tableName, 'insert');
    const rows = Array.isArray(data) ? data : [data];
    if (rows.length === 0) return { rows: [] as T[], rowCount: 0 };

    const columns = Object.keys(rows[0]).map(c => assertIdent(c, 'insert column'));
    const placeholders = columns.map(() => '?').join(', ');
    const values = rows.flatMap(row => columns.map(col => row[col]));
    const columnList = columns.map(quoteIdent).join(', ');
    const returningClause = this.buildReturning(options?.returning);

    if (rows.length === 1) {
      const sql = `INSERT INTO ${quoteIdent(safeTable)} (${columnList}) VALUES (${placeholders})${returningClause}`;
      return this.query<T>(sql, values);
    }

    // Batch insert
    const allPlaceholders = rows.map(() => `(${placeholders})`).join(', ');
    const sql = `INSERT INTO ${quoteIdent(safeTable)} (${columnList}) VALUES ${allPlaceholders}${returningClause}`;
    return this.query<T>(sql, values);
  }

  /** Update rows. `returning` works on PostgreSQL. */
  async update<T = Record<string, unknown>>(
    tableName: string,
    data: Record<string, unknown>,
    where: Record<string, unknown>,
    options?: { returning?: '*' | string[] }
  ): Promise<QueryResult<T>> {
    const safeTable = assertIdent(tableName, 'update');
    const setCols = Object.keys(data)
      .map(k => `${quoteIdent(assertIdent(k, 'update column'))} = ?`)
      .join(', ');
    const whereCols = Object.keys(where)
      .map(k => `${quoteIdent(assertIdent(k, 'update where'))} = ?`)
      .join(' AND ');
    const values = [...Object.values(data), ...Object.values(where)];
    const returningClause = this.buildReturning(options?.returning);
    const sql = `UPDATE ${quoteIdent(safeTable)} SET ${setCols} WHERE ${whereCols}${returningClause}`;
    return this.query<T>(sql, values);
  }

  /** Delete rows. `returning` works on PostgreSQL. */
  async delete<T = Record<string, unknown>>(
    tableName: string,
    where: Record<string, unknown>,
    options?: { returning?: '*' | string[] }
  ): Promise<QueryResult<T>> {
    const safeTable = assertIdent(tableName, 'delete');
    const whereCols = Object.keys(where)
      .map(k => `${quoteIdent(assertIdent(k, 'delete where'))} = ?`)
      .join(' AND ');
    const returningClause = this.buildReturning(options?.returning);
    const sql = `DELETE FROM ${quoteIdent(safeTable)} WHERE ${whereCols}${returningClause}`;
    return this.query<T>(sql, Object.values(where));
  }

  private buildReturning(returning?: '*' | string[]): string {
    if (!returning) return '';
    if (this.config.driver === 'sqlite') return ''; // bun:sqlite does not surface RETURNING via query path
    if (returning === '*') return ' RETURNING *';
    const safeCols = returning.map(c => quoteIdent(assertIdent(c, 'returning')));
    return ` RETURNING ${safeCols.join(', ')}`;
  }

  /** Run raw SQL */
  async raw<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    return this.query<T>(sql, values);
  }

  /** Execute schema SQL (CREATE TABLE etc) */
  async exec(sql: string): Promise<void> {
    if (this.config.driver === 'sqlite') {
      if (!this.sqliteDb) await this.connect();
      this.sqliteDb.exec(sql);
    } else {
      await this.query(sql);
    }
  }

  /** Create table from schema */
  async createTable(schema: TableSchema): Promise<void> {
    const sql = generateCreateTableSQL(schema, this.config.driver);
    await this.exec(sql);
  }

  /**
   * Transaction.
   *
   * @param fn The callback run inside the transaction.
   * @param options.isolation PostgreSQL only. One of 'read uncommitted', 'read committed',
   *                          'repeatable read', 'serializable'. Ignored on SQLite.
   * @param options.readOnly PostgreSQL only. Starts the transaction in READ ONLY mode.
   */
  async transaction<T>(
    fn: (db: Database) => Promise<T>,
    options?: {
      isolation?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';
      readOnly?: boolean;
    }
  ): Promise<T> {
    await this.exec('BEGIN');
    if (options && this.config.driver === 'postgres') {
      const parts: string[] = [];
      if (options.isolation) parts.push(`ISOLATION LEVEL ${options.isolation.toUpperCase()}`);
      if (options.readOnly) parts.push('READ ONLY');
      if (parts.length > 0) {
        await this.exec(`SET TRANSACTION ${parts.join(' ')}`);
      }
    }
    try {
      const result = await fn(this);
      await this.exec('COMMIT');
      return result;
    } catch (err) {
      await this.exec('ROLLBACK');
      throw err;
    }
  }

  /** Close connection */
  async close(): Promise<void> {
    if (this.sqliteDb) {
      this.sqliteDb.close();
      this.sqliteDb = null;
    }
    if (this.pgClient) {
      await this.pgClient.end();
      this.pgClient = null;
    }
  }
}

/* ═══════ DATALOADER (N+1 Prevention) ═══════ */

class DataLoader<K, V> {
  private batch: Map<K, { resolve: (v: V) => void; reject: (e: Error) => void }[]> = new Map();
  private scheduled = false;

  constructor(
    private batchFn: (keys: K[]) => Promise<Map<K, V>>,
    private maxBatchSize = 100
  ) {}

  async load(key: K): Promise<V> {
    return new Promise((resolve, reject) => {
      if (!this.batch.has(key)) this.batch.set(key, []);
      this.batch.get(key)!.push({ resolve, reject });

      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => this.executeBatch());
      }
    });
  }

  private async executeBatch() {
    this.scheduled = false;
    const entries = new Map(this.batch);
    this.batch.clear();

    const keys = [...entries.keys()];
    try {
      const results = await this.batchFn(keys);
      for (const [key, callbacks] of entries) {
        const value = results.get(key);
        for (const cb of callbacks) {
          if (value !== undefined) cb.resolve(value);
          else cb.reject(new Error(`Key not found: ${key}`));
        }
      }
    } catch (err: any) {
      for (const callbacks of entries.values()) {
        for (const cb of callbacks) cb.reject(err);
      }
    }
  }
}

/* ═══════ MIGRATION RUNNER ═══════ */

interface MigrationRunnerOptions {
  /** Directory containing migration files. Each file exports { up, down }. */
  dir?: string;
  /** Table name for tracking applied migrations. Default: _vajra_migrations */
  table?: string;
  /** Pass migrations directly instead of loading from dir. */
  migrations?: MigrationFile[];
}

interface MigrationRecord {
  name: string;
  applied_at: string;
}

class MigrationRunner {
  private db: Database;
  private table: string;
  private dir?: string;
  private inlineMigrations?: MigrationFile[];

  constructor(db: Database, options: MigrationRunnerOptions = {}) {
    this.db = db;
    this.table = options.table ?? '_vajra_migrations';
    this.dir = options.dir;
    this.inlineMigrations = options.migrations;
  }

  /** Create migrations tracking table if not exists */
  private async ensureTable(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${this.table}" (
        "name" TEXT PRIMARY KEY,
        "applied_at" TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /** Get list of already applied migration names */
  async applied(): Promise<string[]> {
    await this.ensureTable();
    const result = await this.db.query<MigrationRecord>(
      `SELECT "name" FROM "${this.table}" ORDER BY "name" ASC`
    );
    return result.rows.map(r => r.name);
  }

  /** Load migrations from dir or inline array, sorted by name */
  private async loadMigrations(): Promise<MigrationFile[]> {
    if (this.inlineMigrations) {
      return [...this.inlineMigrations].sort((a, b) => a.name.localeCompare(b.name));
    }

    if (!this.dir) throw new Error('Vajra Migration: provide dir or migrations option');

    const { readdirSync } = await import('fs');
    const { join, extname, basename } = await import('path');

    const files = readdirSync(this.dir)
      .filter(f => ['.ts', '.js'].includes(extname(f)))
      .sort();

    const migrations: MigrationFile[] = [];
    for (const file of files) {
      const mod = await import(join(this.dir, file));
      migrations.push({
        name: basename(file, extname(file)),
        up: mod.up,
        down: mod.down,
      });
    }
    return migrations;
  }

  /** Get pending migrations (not yet applied) */
  async pending(): Promise<MigrationFile[]> {
    const appliedNames = new Set(await this.applied());
    const all = await this.loadMigrations();
    return all.filter(m => !appliedNames.has(m.name));
  }

  /** Run all pending migrations (up) */
  async up(): Promise<{ applied: string[]; count: number }> {
    const pendingList = await this.pending();
    const appliedNames: string[] = [];

    for (const migration of pendingList) {
      await this.db.transaction(async (tx) => {
        await migration.up(tx);
        await tx.query(
          `INSERT INTO "${this.table}" ("name", "applied_at") VALUES (?, ?)`,
          [migration.name, new Date().toISOString()]
        );
      });
      appliedNames.push(migration.name);
    }

    return { applied: appliedNames, count: appliedNames.length };
  }

  /** Rollback last N migrations (down). Default: 1 */
  async down(steps = 1): Promise<{ reverted: string[]; count: number }> {
    if (steps <= 0) return { reverted: [], count: 0 };

    const appliedNames = await this.applied();
    const all = await this.loadMigrations();
    const migrationMap = new Map(all.map(m => [m.name, m]));

    const toRevert = appliedNames.slice(-steps).reverse();
    const revertedNames: string[] = [];

    for (const name of toRevert) {
      const migration = migrationMap.get(name);
      if (!migration) throw new Error(`Vajra Migration: cannot find migration "${name}" to revert`);

      await this.db.transaction(async (tx) => {
        await migration.down(tx);
        await tx.query(`DELETE FROM "${this.table}" WHERE "name" = ?`, [name]);
      });
      revertedNames.push(name);
    }

    return { reverted: revertedNames, count: revertedNames.length };
  }

  /** Reset: revert all, then apply all */
  async reset(): Promise<{ reverted: string[]; applied: string[] }> {
    const appliedNames = await this.applied();
    const { reverted } = await this.down(appliedNames.length);
    const { applied } = await this.up();
    return { reverted, applied };
  }

  /** Get status of all migrations */
  async status(): Promise<Array<{ name: string; applied: boolean; appliedAt: string | null }>> {
    const appliedList = await this.applied();
    const appliedSet = new Set(appliedList);
    const all = await this.loadMigrations();

    // Get applied_at timestamps
    const result = await this.db.query<MigrationRecord>(
      `SELECT "name", "applied_at" FROM "${this.table}"`
    );
    const timestamps = new Map(result.rows.map(r => [r.name, r.applied_at]));

    return all.map(m => ({
      name: m.name,
      applied: appliedSet.has(m.name),
      appliedAt: timestamps.get(m.name) ?? null,
    }));
  }
}

/**
 * Create a migration runner.
 *
 * @example
 *   // From directory (file-based migrations)
 *   const runner = createMigrationRunner(db, { dir: './migrations' });
 *   await runner.up();       // Apply all pending
 *   await runner.down();     // Revert last 1
 *   await runner.down(3);    // Revert last 3
 *   await runner.status();   // Show all with applied status
 *
 *   // Inline migrations (tests, simple apps)
 *   const runner = createMigrationRunner(db, {
 *     migrations: [
 *       {
 *         name: '001_create_users',
 *         up: async (db) => { await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)'); },
 *         down: async (db) => { await db.exec('DROP TABLE users'); },
 *       },
 *     ],
 *   });
 */
export function createMigrationRunner(db: Database, options: MigrationRunnerOptions = {}): MigrationRunner {
  return new MigrationRunner(db, options);
}

/* ═══════ PUBLIC API ═══════ */

/**
 * Create a database connection.
 *
 * @example
 *   // SQLite (development)
 *   const db = createDatabase({ driver: 'sqlite', path: './dev.db' });
 *
 *   // PostgreSQL (production)
 *   const db = createDatabase({ driver: 'postgres', url: process.env.DATABASE_URL });
 *
 *   // Query builder
 *   const users = await db.from('users').where({ role: 'admin' }).orderBy('name').execute();
 *
 *   // Raw query
 *   const result = await db.raw('SELECT * FROM users WHERE age > ?', [18]);
 *
 *   // Insert
 *   await db.insert('users', { name: 'Vajra', email: 'vajra@example.com' });
 *
 *   // Transaction
 *   await db.transaction(async (tx) => {
 *     await tx.insert('orders', { userId: 1, total: 100 });
 *     await tx.update('users', { balance: 0 }, { id: 1 });
 *   });
 */
export function createDatabase(config: DatabaseConfig): Database {
  return new Database(config);
}

/**
 * Create a DataLoader for batching queries (N+1 prevention).
 *
 * @example
 *   const userLoader = createLoader(async (ids: string[]) => {
 *     const users = await db.raw('SELECT * FROM users WHERE id IN (?)', [ids]);
 *     return new Map(users.rows.map(u => [u.id, u]));
 *   });
 *
 *   // These 50 calls become 1 query
 *   const users = await Promise.all(userIds.map(id => userLoader.load(id)));
 */
export function createLoader<K, V>(batchFn: (keys: K[]) => Promise<Map<K, V>>): DataLoader<K, V> {
  return new DataLoader(batchFn);
}

export {
  Database,
  QueryBuilder,
  DataLoader,
  generateCreateTableSQL,
  columnTypeToSQL,
};

export type { DatabaseConfig, TableSchema, ColumnDef, ColumnType, QueryResult, MigrationFile, MigrationRunnerOptions };
