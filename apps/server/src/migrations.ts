import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const migrationsDir = existsSync(join(process.cwd(), "db/migrations"))
  ? join(process.cwd(), "db/migrations")
  : fileURLToPath(new URL("../../../db/migrations", import.meta.url));

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");

  const legacy = await pool.query("SELECT to_regclass('public.lobbies') AS lobbies, NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0001_initial.sql') AS missing");
  if (legacy.rows[0]?.lobbies === "lobbies" && legacy.rows[0]?.missing === true) {
    await pool.query("INSERT INTO schema_migrations(version) VALUES ('0001_initial.sql') ON CONFLICT DO NOTHING");
  }

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
    if (applied.rowCount) continue;

    const sql = await readFile(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
