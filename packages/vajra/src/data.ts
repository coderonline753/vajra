/**
 * Vajra Data — Lightweight typed query layer + schema toolkit
 * SQL-first, multi-database (SQLite dev, PostgreSQL prod).
 * Not a full ORM. No Active Record. No magic.
 *
 * @example
 *   const db = createDatabase({ driver: 'sqlite', path: './dev.db' });
 *   const users = await db.query('SELECT * FROM users WHERE role = ?', ['admin']);
 */

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

  select(...columns: string[]): this {
    this._select = columns.join(', ');
    return this;
  }

  where(conditions: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(conditions)) {
      if (value === null) {
        this._where.push({ clause: `"${key}" IS NULL`, values: [] });
      } else if (Array.isArray(value)) {
        const placeholders = value.map(() => '?').join(', ');
        this._where.push({ clause: `"${key}" IN (${placeholders})`, values: value });
      } else {
        this._where.push({ clause: `"${key}" = ?`, values: [value] });
      }
    }
    return this;
  }

  whereRaw(clause: string, values: unknown[] = []): this {
    this._where.push({ clause, values });
    return this;
  }

  orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): this {
    this._orderBy.push(`"${column}" ${direction.toUpperCase()}`);
    return this;
  }

  limit(n: number): this {
    this._limit = n;
    return this;
  }

  offset(n: number): this {
    this._offset = n;
    return this;
  }

  join(table: string, on: string): this {
    this._joins.push(`JOIN "${table}" ON ${on}`);
    return this;
  }

  leftJoin(table: string, on: string): this {
    this._joins.push(`LEFT JOIN "${table}" ON ${on}`);
    return this;
  }

  async execute(): Promise<T[]> {
    let sql = `SELECT ${this._select} FROM "${this._table}"`;

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
    if (this._limit) sql += ` LIMIT ${this._limit}`;
    if (this._offset) sql += ` OFFSET ${this._offset}`;

    const result = await this.db.query<T>(sql, values);
    return result.rows;
  }

  async first(): Promise<T | null> {
    this._limit = 1;
    const rows = await this.execute();
    return rows[0] || null;
  }

  async count(): Promise<number> {
    this._select = 'COUNT(*) as count';
    const rows = await this.execute();
    return (rows[0] as any)?.count || 0;
  }
}

/* ═══════ DATABASE CLASS ═══════ */

class Database {
  private config: DatabaseConfig;
  private sqliteDb: any = null;
  private pgClient: any = null;

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

      // Replace ? placeholders with $1, $2 etc for consistency
      const stmt = this.sqliteDb.prepare(sql);
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

      const result = await this.pgClient.unsafe(pgSql, values as any[]);
      return { rows: result as T[], rowCount: result.length };
    }

    throw new Error(`Unsupported driver: ${this.config.driver}`);
  }

  /** Typed query builder */
  from<T = Record<string, unknown>>(tableName: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this, tableName);
  }

  /** Insert row(s) */
  async insert<T = Record<string, unknown>>(
    tableName: string,
    data: Record<string, unknown> | Record<string, unknown>[]
  ): Promise<QueryResult<T>> {
    const rows = Array.isArray(data) ? data : [data];
    if (rows.length === 0) return { rows: [] as T[], rowCount: 0 };

    const columns = Object.keys(rows[0]);
    const placeholders = columns.map(() => '?').join(', ');
    const values = rows.flatMap(row => columns.map(col => row[col]));

    if (rows.length === 1) {
      const sql = `INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;
      return this.query<T>(sql, values);
    }

    // Batch insert
    const allPlaceholders = rows.map(() => `(${placeholders})`).join(', ');
    const sql = `INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES ${allPlaceholders}`;
    return this.query<T>(sql, values);
  }

  /** Update rows */
  async update(
    tableName: string,
    data: Record<string, unknown>,
    where: Record<string, unknown>
  ): Promise<QueryResult> {
    const setCols = Object.keys(data).map(k => `"${k}" = ?`).join(', ');
    const whereCols = Object.keys(where).map(k => `"${k}" = ?`).join(' AND ');
    const values = [...Object.values(data), ...Object.values(where)];
    const sql = `UPDATE "${tableName}" SET ${setCols} WHERE ${whereCols}`;
    return this.query(sql, values);
  }

  /** Delete rows */
  async delete(tableName: string, where: Record<string, unknown>): Promise<QueryResult> {
    const whereCols = Object.keys(where).map(k => `"${k}" = ?`).join(' AND ');
    const sql = `DELETE FROM "${tableName}" WHERE ${whereCols}`;
    return this.query(sql, Object.values(where));
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

  /** Transaction */
  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    await this.exec('BEGIN');
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
