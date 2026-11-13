import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
export function env(name: string) {
  const value = process.env[name];
  if (!value) throw Error("Задайте " + name);
  return value;
}
export const pool = new pg.Pool({
  connectionString: env("DATABASE_URL"),
  max: 12,
});
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate() {
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(601173)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS device_migrations (name text PRIMARY KEY)",
    );
    for (const name of (await readdir("migrations/social"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (
        (
          await client.query("SELECT 1 FROM device_migrations WHERE name=$1", [
            name,
          ])
        ).rowCount
      )
        continue;
      await client.query(await readFile("migrations/social/" + name, "utf8"));
      await client.query("INSERT INTO device_migrations VALUES ($1)", [name]);
    }
  });
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const deny = () => new ApiError(403, "Доступ ограничен");
