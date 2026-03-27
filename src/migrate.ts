import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import cassandra from "cassandra-driver";

async function migrate() {
  const host = process.env.SCYLLADB_HOST;
  const dc = process.env.SCYLLADB_DC;
  const username = process.env.SCYLLADB_USERNAME;
  const password = process.env.SCYLLADB_PASSWORD;

  if (!host || !dc || !username || !password) {
    throw new Error(
      "Missing required env vars. Copy .env.example → .env and fill in:\n" +
        "  SCYLLADB_HOST, SCYLLADB_DC, SCYLLADB_USERNAME, SCYLLADB_PASSWORD"
    );
  }

  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../schema.cql");
  const schemaCql = await readFile(schemaPath, "utf8");
  const statements = schemaCql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  console.log(`Connecting to ScyllaDB Cloud at ${host} …`);

  const client = new cassandra.Client({
    contactPoints: [host],
    localDataCenter: dc,
    credentials: { username, password },
  });
  await client.connect();

  for (const statement of statements) {
    await client.execute(statement);
    console.log(`  ✓ ${statement.split("\n")[0].slice(0, 72)}`);
  }

  await client.shutdown();
  console.log("\nMigration complete. Keyspace and tables are ready.");
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
