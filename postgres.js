import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function postgresConfig(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('Configure a PostgreSQL DATABASE_URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1)
  )
    throw new Error('Configure a PostgreSQL DATABASE_URL');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    !local &&
    (url.searchParams.getAll('sslmode').length !== 1 ||
      url.searchParams.get('sslmode') !== 'verify-full' ||
      ['ssl', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat'].some((key) =>
        url.searchParams.has(key),
      ))
  )
    throw new Error('Remote PostgreSQL requires sslmode=verify-full');
  if (!local) url.searchParams.delete('sslmode');
  return {
    connectionString: url.toString(),
    ...(!local ? { ssl: { rejectUnauthorized: true, servername: url.hostname } } : {}),
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 20000,
    application_name: 'pulsewatch',
  };
}

export function postgresSql(source, values = []) {
  const named =
    values.length === 1 && values[0] && typeof values[0] === 'object' && !Array.isArray(values[0]);
  const bound = [];
  let positional = 0;
  const text = source.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|\$[A-Za-z_]\w*|\?|\b(?:monitors|incidents|checks|notification_outbox|cycle_leases)\b/g,
    (token) => {
      if (token[0] === "'" || token[0] === '"') return token;
      if (token === '?' || token[0] === '$') {
        if (
          token === '?'
            ? named || positional >= values.length
            : !named || !Object.hasOwn(values[0], token)
        )
          throw new Error('SQL binding mismatch');
        bound.push(token === '?' ? values[positional++] : values[0][token]);
        return '$' + bound.length;
      }
      return 'pulsewatch.' + token;
    },
  );
  if (!named && positional !== values.length) throw new Error('SQL binding mismatch');
  return { text, values: bound };
}

function rowsOf(result) {
  return result.rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        const field = result.fields.find((field) => field.name === key);
        if (value !== null && [20, 21, 23].includes(field?.dataTypeID)) {
          const number = Number(value);
          if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds API range');
          return [key, number];
        }
        if (value !== null && field?.dataTypeID === 1700) {
          const number = Number(value);
          if (!Number.isFinite(number)) throw new Error('Invalid database number');
          return [key, number];
        }
        return [key, value];
      }),
    ),
  );
}

export async function createPostgresDb(connectionString, { seed, initialize = true } = {}) {
  const pool = new pg.Pool(postgresConfig(connectionString));
  pool.on('error', () => console.error({ event: 'database_pool', status: 'unavailable' }));
  const context = new AsyncLocalStorage();
  let closed = false;
  async function close() {
    if (!closed) {
      closed = true;
      await pool.end();
    }
  }
  async function transaction(operation) {
    if (closed) throw new Error('Database is closed');
    if (context.getStore()) return operation();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('pulsewatch-writes'))");
      await client.query('SET LOCAL search_path TO pulsewatch');
      const result = await context.run(client, operation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  const store = {
    dialect: 'postgres',
    transaction,
    close,
    initialized: false,
    prepare(source) {
      async function execute(values, returning = false) {
        if (closed) throw new Error('Database is closed');
        const query = postgresSql(source, values);
        if (
          returning &&
          /^\s*INSERT INTO (monitors|incidents|checks|notification_outbox)\b/i.test(source) &&
          !/\bRETURNING\b/i.test(source)
        )
          query.text += ' RETURNING id';
        return (context.getStore() || pool).query(query);
      }
      return {
        async all(...values) {
          return rowsOf(await execute(values));
        },
        async get(...values) {
          return rowsOf(await execute(values))[0];
        },
        async run(...values) {
          const result = await execute(values, true);
          return {
            changes: result.rowCount,
            lastInsertRowid: result.rows[0]?.id,
          };
        },
      };
    },
  };
  const schema = readFileSync(new URL('./postgres-schema.sql', import.meta.url), 'utf8');
  const notifications = readFileSync(
    new URL('./postgres-notifications.sql', import.meta.url),
    'utf8',
  );
  const checksum = createHash('sha256')
    .update((schema + '\n' + notifications).replaceAll('\r\n', '\n'))
    .digest('hex');
  try {
    if (!initialize) {
      const found = await pool.query(
        'SELECT checksum FROM pulsewatch.schema_migrations WHERE version=1',
      );
      if (found.rows[0]?.checksum !== checksum)
        throw new Error('Apply the application database migration first');
      return store;
    }
    await transaction(async () => {
      const client = context.getStore();
      await client.query('CREATE SCHEMA IF NOT EXISTS pulsewatch');
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)',
      );
      const found = await client.query('SELECT checksum FROM schema_migrations WHERE version=1');
      if (found.rows[0]) {
        if (found.rows[0].checksum !== checksum)
          throw new Error('Applied migration checksum mismatch');
        return;
      }
      await client.query(schema);
      if (seed) {
        const source = seed();
        try {
          for (const [table, key] of [
            ['monitors', 'id'],
            ['incidents', 'id'],
            ['checks', 'id'],
            ['notification_outbox', 'id'],
          ]) {
            const original = source.prepare('SELECT * FROM ' + table + ' ORDER BY ' + key).all();
            for (const row of original) {
              const columns = Object.keys(row);
              await client.query(
                'INSERT INTO ' +
                  table +
                  '(' +
                  columns.map((c) => '"' + c.replaceAll('"', '""') + '"').join(',') +
                  ') VALUES(' +
                  columns.map((_, i) => '$' + (i + 1)).join(',') +
                  ')',
                Object.values(row),
              );
            }
            const restored = rowsOf(
              await client.query('SELECT * FROM ' + table + ' ORDER BY ' + key),
            );
            const canonical = (rows) =>
              JSON.stringify(
                rows.map((row) => Object.entries(row).sort(([a], [b]) => a.localeCompare(b))),
              );
            if (canonical(original) !== canonical(restored))
              throw new Error('PostgreSQL import verification failed');
          }
          for (const table of ['monitors', 'incidents', 'checks', 'notification_outbox'])
            await client.query(
              "SELECT setval(pg_get_serial_sequence($1,'id'),coalesce((SELECT max(id) FROM " +
                table +
                '),1),EXISTS(SELECT 1 FROM ' +
                table +
                '))',
              [table],
            );
        } finally {
          source.close();
        }
      }
      await client.query(notifications);
      await client.query('INSERT INTO schema_migrations VALUES(1,$1)', [checksum]);
      store.initialized = true;
    });
    return store;
  } catch (error) {
    await close();
    throw error;
  }
}

const sqliteWrites = new WeakMap();
export async function writeTransaction(db, operation) {
  if (db.dialect === 'postgres') return db.transaction(operation);
  const previous = sqliteWrites.get(db) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  sqliteWrites.set(db, turn);
  await previous;
  try {
    db.exec('BEGIN IMMEDIATE');
    const result = await operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    release();
    if (sqliteWrites.get(db) === turn) sqliteWrites.delete(db);
  }
}
