import pg from "pg";

export function createDatabase(connectionString, schema = "public") {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid DATABASE_SCHEMA");
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, options: `-c search_path=${schema},public` });
  const documents = new Map();

  function document(key, seed) {
    let items = seed;
    let queue = Promise.resolve();
    function update(change) {
      const operation = queue.then(async () => {
        const next = change(items);
        await pool.query("UPDATE app_documents SET data=$2::jsonb, updated_at=now() WHERE key=$1", [key, JSON.stringify(next.items)]);
        items = next.items;
        return next.result;
      });
      queue = operation.catch(() => {});
      return operation;
    }
    const store = { read: () => items, update, load: (value) => { items = value; }, seed, flush: () => queue };
    documents.set(key, store);
    return store;
  }

  async function initialize() {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_documents (key text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, username text UNIQUE NOT NULL, display_name text NOT NULL, password_hash text NOT NULL, salt text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS watch_history (user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, content_key text NOT NULL, media jsonb NOT NULL, position double precision NOT NULL DEFAULT 0, duration double precision NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id, content_key));
      CREATE INDEX IF NOT EXISTS watch_history_recent ON watch_history(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS rooms (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    `);
    for (const [key, store] of documents) {
      await pool.query("INSERT INTO app_documents(key,data) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING", [key, JSON.stringify(store.seed)]);
      const result = await pool.query("SELECT data FROM app_documents WHERE key=$1", [key]);
      if (!Array.isArray(result.rows[0].data)) throw new Error(`Invalid database document: ${key}`);
      store.load(result.rows[0].data);
    }
  }

  async function close() {
    await Promise.all([...documents.values()].map((store) => store.flush()));
    await pool.end();
  }
  return { pool, document, initialize, close };
}
