import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDatabase, createLoader, table, column, generateCreateTableSQL } from '../src/data';

describe('Schema Builder', () => {
  test('creates table schema', () => {
    const users = table('users', {
      id: { type: 'serial', primaryKey: true },
      name: { type: 'text', notNull: true },
      email: { type: 'text', unique: true, notNull: true },
    });
    expect(users.name).toBe('users');
    expect(Object.keys(users.columns)).toHaveLength(3);
  });

  test('generates SQLite CREATE TABLE', () => {
    const schema = table('users', {
      id: { type: 'serial', primaryKey: true },
      name: { type: 'text', notNull: true },
      email: { type: 'text', unique: true },
      active: { type: 'boolean', default: true },
    });
    const sql = generateCreateTableSQL(schema, 'sqlite');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "users"');
    expect(sql).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(sql).toContain('TEXT NOT NULL');
    expect(sql).toContain('TEXT UNIQUE');
    expect(sql).toContain('DEFAULT 1');
  });

  test('generates PostgreSQL CREATE TABLE', () => {
    const schema = table('users', {
      id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
      name: { type: 'text', notNull: true },
      data: { type: 'json' },
      created: { type: 'timestamp', default: 'now()' },
    });
    const sql = generateCreateTableSQL(schema, 'postgres');
    expect(sql).toContain('UUID PRIMARY KEY');
    expect(sql).toContain('DEFAULT gen_random_uuid()');
    expect(sql).toContain('JSONB');
    expect(sql).toContain('TIMESTAMPTZ');
    expect(sql).toContain('DEFAULT now()');
  });

  test('generates foreign key reference', () => {
    const schema = table('posts', {
      id: { type: 'serial', primaryKey: true },
      authorId: { type: 'uuid', references: { table: 'users', column: 'id', onDelete: 'cascade' } },
    });
    const sql = generateCreateTableSQL(schema, 'postgres');
    expect(sql).toContain('REFERENCES "users"("id")');
    expect(sql).toContain('ON DELETE CASCADE');
  });
});

describe('SQLite Database', () => {
  let db: ReturnType<typeof createDatabase>;

  beforeEach(async () => {
    db = createDatabase({ driver: 'sqlite', path: ':memory:' });
    await db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        role TEXT DEFAULT 'user'
      )
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  test('inserts and queries data', async () => {
    await db.insert('users', { name: 'Vajra', email: 'vajra@test.com' });
    const result = await db.query('SELECT * FROM users');
    expect(result.rows).toHaveLength(1);
    expect((result.rows[0] as any).name).toBe('Vajra');
  });

  test('query builder with where', async () => {
    await db.insert('users', { name: 'Alice', email: 'alice@test.com', role: 'admin' });
    await db.insert('users', { name: 'Bob', email: 'bob@test.com', role: 'user' });

    const admins = await db.from('users').where({ role: 'admin' }).execute();
    expect(admins).toHaveLength(1);
    expect((admins[0] as any).name).toBe('Alice');
  });

  test('query builder with orderBy and limit', async () => {
    await db.insert('users', { name: 'Charlie', email: 'c@test.com' });
    await db.insert('users', { name: 'Alice', email: 'a@test.com' });
    await db.insert('users', { name: 'Bob', email: 'b@test.com' });

    const result = await db.from('users').orderBy('name', 'asc').limit(2).execute();
    expect(result).toHaveLength(2);
    expect((result[0] as any).name).toBe('Alice');
    expect((result[1] as any).name).toBe('Bob');
  });

  test('query builder first()', async () => {
    await db.insert('users', { name: 'Only', email: 'only@test.com' });
    const user = await db.from('users').where({ name: 'Only' }).first();
    expect(user).not.toBeNull();
    expect((user as any).email).toBe('only@test.com');
  });

  test('query builder first() returns null for no match', async () => {
    const user = await db.from('users').where({ name: 'NonExistent' }).first();
    expect(user).toBeNull();
  });

  test('query builder count()', async () => {
    await db.insert('users', { name: 'A', email: 'a@t.com' });
    await db.insert('users', { name: 'B', email: 'b@t.com' });
    const count = await db.from('users').count();
    expect(count).toBe(2);
  });

  test('update rows', async () => {
    await db.insert('users', { name: 'Old', email: 'old@test.com' });
    await db.update('users', { name: 'New' }, { email: 'old@test.com' });
    const user = await db.from('users').where({ email: 'old@test.com' }).first();
    expect((user as any).name).toBe('New');
  });

  test('delete rows', async () => {
    await db.insert('users', { name: 'Delete', email: 'del@test.com' });
    await db.delete('users', { email: 'del@test.com' });
    const count = await db.from('users').count();
    expect(count).toBe(0);
  });

  test('transaction commit', async () => {
    await db.transaction(async (tx) => {
      await tx.insert('users', { name: 'TxUser', email: 'tx@test.com' });
    });
    const count = await db.from('users').count();
    expect(count).toBe(1);
  });

  test('transaction rollback on error', async () => {
    try {
      await db.transaction(async (tx) => {
        await tx.insert('users', { name: 'Fail', email: 'fail@test.com' });
        throw new Error('Forced rollback');
      });
    } catch {}
    const count = await db.from('users').count();
    expect(count).toBe(0);
  });

  test('raw query with params', async () => {
    await db.insert('users', { name: 'Raw', email: 'raw@test.com', role: 'admin' });
    const result = await db.raw('SELECT * FROM users WHERE role = ?', ['admin']);
    expect(result.rows).toHaveLength(1);
  });

  test('createTable from schema', async () => {
    const schema = table('products', {
      id: { type: 'serial', primaryKey: true },
      title: { type: 'text', notNull: true },
      price: { type: 'real', notNull: true },
    });
    await db.createTable(schema);
    await db.insert('products', { title: 'Vajra', price: 0 });
    const products = await db.from('products').execute();
    expect(products).toHaveLength(1);
  });
});

describe('DataLoader', () => {
  test('batches multiple loads into single call', async () => {
    let batchCalls = 0;
    const loader = createLoader<string, string>(async (keys) => {
      batchCalls++;
      return new Map(keys.map(k => [k, `value_${k}`]));
    });

    const [a, b, c] = await Promise.all([
      loader.load('a'),
      loader.load('b'),
      loader.load('c'),
    ]);

    expect(a).toBe('value_a');
    expect(b).toBe('value_b');
    expect(c).toBe('value_c');
    expect(batchCalls).toBe(1); // Single batch call
  });

  test('deduplicates same key', async () => {
    let batchKeys: string[] = [];
    const loader = createLoader<string, number>(async (keys) => {
      batchKeys = keys;
      return new Map(keys.map(k => [k, k.length]));
    });

    const [a, b] = await Promise.all([
      loader.load('same'),
      loader.load('same'),
    ]);

    expect(a).toBe(4);
    expect(b).toBe(4);
  });
});

describe('Identifier safety', () => {
  let db: ReturnType<typeof createDatabase>;

  beforeEach(async () => {
    db = createDatabase({ driver: 'sqlite', path: ':memory:' });
    await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT)');
  });

  afterEach(async () => {
    await db.close();
  });

  test('rejects SQL injection in from()', () => {
    expect(() => db.from('users; DROP TABLE users')).toThrow(/Invalid identifier/);
  });

  test('rejects SQL injection in select()', () => {
    const qb = db.from('users');
    expect(() => qb.select('name; DROP TABLE users')).toThrow(/Invalid identifier/);
  });

  test('rejects SQL injection in where keys', () => {
    const qb = db.from('users');
    expect(() => qb.where({ 'id = 1; DROP': 'x' })).toThrow(/Invalid identifier/);
  });

  test('rejects SQL injection in orderBy', () => {
    const qb = db.from('users');
    expect(() => qb.orderBy('name; DROP TABLE users')).toThrow(/Invalid identifier/);
  });

  test('rejects SQL injection in insert table name', async () => {
    await expect(
      db.insert('users; DROP TABLE users', { name: 'X', email: 'x@x.x' }),
    ).rejects.toThrow(/Invalid identifier/);
  });

  test('rejects SQL injection in insert column name', async () => {
    await expect(
      db.insert('users', { 'name; DROP': 'X' }),
    ).rejects.toThrow(/Invalid identifier/);
  });

  test('rejects SQL injection in update', async () => {
    await expect(
      db.update('users; DROP', { name: 'X' }, { id: 1 }),
    ).rejects.toThrow(/Invalid identifier/);
  });

  test('rejects SQL injection in delete', async () => {
    await expect(
      db.delete('users; DROP', { id: 1 }),
    ).rejects.toThrow(/Invalid identifier/);
  });

  test('accepts qualified select (table.column)', async () => {
    await db.insert('users', { name: 'A', email: 'a@x.x' });
    const rows = await db.from('users').select('users.name').execute();
    expect(rows[0]).toHaveProperty('name', 'A');
  });

  test('selectRaw escape hatch for aggregates', async () => {
    await db.insert('users', { name: 'A', email: 'a@x.x' });
    await db.insert('users', { name: 'B', email: 'b@x.x' });
    const rows = await db.from('users').selectRaw('COUNT(*) as n').execute();
    expect((rows[0] as { n: number }).n).toBe(2);
  });

  test('join() structured form is safe', async () => {
    await db.exec('CREATE TABLE posts (id INTEGER, user_id INTEGER, title TEXT)');
    await db.insert('users', { id: 1, name: 'A', email: 'a@x.x' });
    await db.insert('posts', { id: 10, user_id: 1, title: 'hi' });
    const rows = await db
      .from('users')
      .select('users.name', 'posts.title')
      .join('posts', { left: 'users.id', right: 'posts.user_id' })
      .execute();
    expect(rows).toHaveLength(1);
  });

  test('join() structured form rejects injection', () => {
    const qb = db.from('users');
    expect(() => qb.join('posts', { left: 'id; DROP', right: 'posts.user_id' })).toThrow(/Invalid identifier/);
  });

  test('limit/offset reject negative or non-integer values', () => {
    const qb = db.from('users');
    expect(() => qb.limit(-1)).toThrow(/non-negative integer/);
    expect(() => qb.limit(1.5)).toThrow(/non-negative integer/);
    expect(() => qb.offset(-5)).toThrow(/non-negative integer/);
  });
});

describe('Transaction isolation', () => {
  let db: ReturnType<typeof createDatabase>;

  beforeEach(async () => {
    db = createDatabase({ driver: 'sqlite', path: ':memory:' });
    await db.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER)');
    await db.insert('accounts', { id: 1, balance: 100 });
  });

  afterEach(async () => {
    await db.close();
  });

  test('isolation options are accepted on SQLite (ignored silently)', async () => {
    const result = await db.transaction(async (tx) => {
      await tx.update('accounts', { balance: 200 }, { id: 1 });
      const rows = await tx.from('accounts').where({ id: 1 }).execute();
      return rows[0];
    }, { isolation: 'serializable' });
    expect((result as { balance: number }).balance).toBe(200);
  });

  test('rollback on throw', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.update('accounts', { balance: 999 }, { id: 1 });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await db.from('accounts').where({ id: 1 }).execute();
    expect((rows[0] as { balance: number }).balance).toBe(100);
  });
});
