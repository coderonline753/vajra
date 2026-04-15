import { describe, it, expect, beforeEach } from 'bun:test';
import { createDatabase, createMigrationRunner, type MigrationFile } from '../src/index';

const migrations: MigrationFile[] = [
  {
    name: '001_create_users',
    up: async (db) => {
      await db.exec('CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT UNIQUE)');
    },
    down: async (db) => {
      await db.exec('DROP TABLE IF EXISTS "users"');
    },
  },
  {
    name: '002_create_posts',
    up: async (db) => {
      await db.exec('CREATE TABLE "posts" ("id" INTEGER PRIMARY KEY, "title" TEXT NOT NULL, "user_id" INTEGER REFERENCES "users"("id"))');
    },
    down: async (db) => {
      await db.exec('DROP TABLE IF EXISTS "posts"');
    },
  },
  {
    name: '003_add_bio',
    up: async (db) => {
      await db.exec('ALTER TABLE "users" ADD COLUMN "bio" TEXT');
    },
    down: async (db) => {
      // SQLite doesn't support DROP COLUMN easily, recreate
      await db.exec(`
        CREATE TABLE "users_backup" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT UNIQUE);
        INSERT INTO "users_backup" SELECT "id", "name", "email" FROM "users";
        DROP TABLE "users";
        ALTER TABLE "users_backup" RENAME TO "users";
      `);
    },
  },
];

function createTestDb() {
  return createDatabase({ driver: 'sqlite', path: ':memory:' });
}

describe('Migration Runner', () => {
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    db = createTestDb();
  });

  it('runs all pending migrations with up()', async () => {
    const runner = createMigrationRunner(db, { migrations });
    const result = await runner.up();

    expect(result.count).toBe(3);
    expect(result.applied).toEqual(['001_create_users', '002_create_posts', '003_add_bio']);

    // Verify tables exist
    const users = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
    expect(users.rows.length).toBe(1);

    const posts = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'");
    expect(posts.rows.length).toBe(1);
  });

  it('returns empty when no pending migrations', async () => {
    const runner = createMigrationRunner(db, { migrations });
    await runner.up();
    const result = await runner.up();

    expect(result.count).toBe(0);
    expect(result.applied).toEqual([]);
  });

  it('tracks applied migrations', async () => {
    const runner = createMigrationRunner(db, { migrations });
    await runner.up();

    const applied = await runner.applied();
    expect(applied).toEqual(['001_create_users', '002_create_posts', '003_add_bio']);
  });

  it('shows pending migrations', async () => {
    const runner = createMigrationRunner(db, { migrations });

    const pending = await runner.pending();
    expect(pending.length).toBe(3);
    expect(pending[0].name).toBe('001_create_users');
  });

  it('shows no pending after full up()', async () => {
    const runner = createMigrationRunner(db, { migrations });
    await runner.up();

    const pending = await runner.pending();
    expect(pending.length).toBe(0);
  });

  it('reverts last migration with down()', async () => {
    const runner = createMigrationRunner(db, { migrations });
    await runner.up();

    const result = await runner.down();
    expect(result.count).toBe(1);
    expect(result.reverted).toEqual(['003_add_bio']);

    const applied = await runner.applied();
    expect(applied.length).toBe(2);
  });

  it('reverts multiple migrations with down(N)', async () => {
    const runner = createMigrationRunner(db, { migrations });
    await runner.up();

    const result = await runner.down(2);
    expect(result.count).toBe(2);
    expect(result.reverted).toEqual(['003_add_bio', '002_create_posts']);

    const applied = await runner.applied();
    expect(applied).toEqual(['001_create_users']);
  });

  it('reverts all migrations with down(all)', async () => {
    const runner = createMigrationRunner(db, { migrations });
    await runner.up();

    const result = await runner.down(3);
    expect(result.count).toBe(3);

    const applied = await runner.applied();
    expect(applied.length).toBe(0);
  });

  it('reset reverts all then applies all', async () => {
    const runner = createMigrationRunner(db, { migrations });
    await runner.up();

    const result = await runner.reset();
    expect(result.reverted.length).toBe(3);
    expect(result.applied.length).toBe(3);

    const applied = await runner.applied();
    expect(applied.length).toBe(3);
  });

  it('status shows applied and pending', async () => {
    const runner = createMigrationRunner(db, { migrations: migrations.slice(0, 3) });

    // Apply only first 2
    const partialRunner = createMigrationRunner(db, { migrations: migrations.slice(0, 2) });
    await partialRunner.up();

    const status = await runner.status();
    expect(status.length).toBe(3);
    expect(status[0].name).toBe('001_create_users');
    expect(status[0].applied).toBe(true);
    expect(status[0].appliedAt).toBeTruthy();
    expect(status[1].applied).toBe(true);
    expect(status[2].name).toBe('003_add_bio');
    expect(status[2].applied).toBe(false);
    expect(status[2].appliedAt).toBeNull();
  });

  it('migrations run in sorted order', async () => {
    const unordered: MigrationFile[] = [
      migrations[2], // 003
      migrations[0], // 001
      migrations[1], // 002
    ];
    const runner = createMigrationRunner(db, { migrations: unordered });
    const result = await runner.up();

    expect(result.applied).toEqual(['001_create_users', '002_create_posts', '003_add_bio']);
  });

  it('uses custom tracking table name', async () => {
    const runner = createMigrationRunner(db, { migrations, table: 'my_migrations' });
    await runner.up();

    const result = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='my_migrations'");
    expect(result.rows.length).toBe(1);
  });

  it('throws when down() cannot find migration file', async () => {
    const runner = createMigrationRunner(db, { migrations: [migrations[0]] });
    await runner.up();

    // Create a runner with empty migrations list to simulate missing file
    const brokenRunner = createMigrationRunner(db, { migrations: [] });
    try {
      await brokenRunner.down();
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e.message).toContain('cannot find migration');
    }
  });

  it('throws when no dir or migrations provided', async () => {
    const runner = createMigrationRunner(db, {});
    try {
      await runner.up();
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain('provide dir or migrations');
    }
  });

  it('migration failure rolls back that migration only', async () => {
    const badMigrations: MigrationFile[] = [
      migrations[0],
      {
        name: '002_bad',
        up: async (db) => {
          await db.exec('CREATE TABLE "good_table" ("id" INTEGER)');
          throw new Error('Intentional failure');
        },
        down: async (db) => {
          await db.exec('DROP TABLE IF EXISTS "good_table"');
        },
      },
    ];

    const runner = createMigrationRunner(db, { migrations: badMigrations });
    try {
      await runner.up();
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toBe('Intentional failure');
    }

    // First migration should have applied
    const applied = await runner.applied();
    expect(applied).toEqual(['001_create_users']);
  });

  it('down(0) reverts nothing', async () => {
    const runner = createMigrationRunner(db, { migrations });
    await runner.up();

    const result = await runner.down(0);
    expect(result.count).toBe(0);
    expect(result.reverted).toEqual([]);
  });

  it('actual data persists after migration', async () => {
    const runner = createMigrationRunner(db, { migrations: [migrations[0]] });
    await runner.up();

    await db.insert('users', { name: 'Vajra', email: 'vajra@test.com' });
    const users = await db.from('users').execute();
    expect(users.length).toBe(1);
    expect((users[0] as any).name).toBe('Vajra');
  });
});
