import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { runMigrations } from "./migrations.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

try {
  await runMigrations(pool);
  console.log("migrations complete");
} finally {
  await pool.end();
}
