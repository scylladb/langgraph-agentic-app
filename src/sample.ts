import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import cassandra from "cassandra-driver";

// ── Minimal RFC 4180 CSV parser ───────────────────────────────────────────────

function parseCsv(raw: string): Record<string, string>[] {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) return [];

  const headers = parseRow(nonEmpty[0]);
  return nonEmpty.slice(1).map((line) => {
    const values = parseRow(line);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
  });
}

function parseRow(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field — "" inside quotes is an escaped double-quote
      let field = "";
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          field += line[i++];
        }
      }
      fields.push(field);
      if (line[i] === ",") i++; // skip comma after closing quote
    } else {
      // Unquoted field
      const end = line.indexOf(",", i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      } else {
        fields.push(line.slice(i, end));
        i = end + 1;
      }
    }
  }
  return fields;
}

// ── Seeding logic ─────────────────────────────────────────────────────────────

async function seed() {
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

  const dataDir = join(dirname(fileURLToPath(import.meta.url)), "../data");

  const [checkpointsCsv, writesCsv] = await Promise.all([
    readFile(join(dataDir, "checkpoints.csv"), "utf8"),
    readFile(join(dataDir, "checkpoint_writes.csv"), "utf8"),
  ]);

  const checkpoints = parseCsv(checkpointsCsv);
  const writes = parseCsv(writesCsv);

  console.log(`Connecting to ScyllaDB Cloud at ${host} …`);

  const client = new cassandra.Client({
    contactPoints: [host],
    localDataCenter: dc,
    keyspace: "langgraph",
    credentials: { username, password },
  });
  await client.connect();

  // ── Insert checkpoints ──────────────────────────────────────────────────────
  console.log(`\nInserting ${checkpoints.length} rows into langgraph.checkpoints …`);

  const cpInsert = `
    INSERT INTO langgraph.checkpoints (
      thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
      checkpoint, metadata, source, step, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  for (const row of checkpoints) {
    await client.execute(
      cpInsert,
      [
        row.thread_id,
        row.checkpoint_ns,
        row.checkpoint_id,
        row.parent_checkpoint_id || null,
        Buffer.from(row.checkpoint, "utf8"),
        Buffer.from(row.metadata, "utf8"),
        row.source,
        parseInt(row.step, 10),
        new Date(row.created_at),
      ],
      { prepare: true }
    );
    console.log(`  ✓ thread=${row.thread_id}  step=${row.step}  source=${row.source}`);
  }

  // ── Insert checkpoint_writes ────────────────────────────────────────────────
  console.log(`\nInserting ${writes.length} rows into langgraph.checkpoint_writes …`);

  const wrInsert = `
    INSERT INTO langgraph.checkpoint_writes (
      thread_id, checkpoint_ns, checkpoint_id, task_id, idx,
      channel, type, value, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    IF NOT EXISTS
  `;

  for (const row of writes) {
    await client.execute(
      wrInsert,
      [
        row.thread_id,
        row.checkpoint_ns,
        row.checkpoint_id,
        row.task_id,
        parseInt(row.idx, 10),
        row.channel,
        row.type,
        Buffer.from(row.value, "utf8"),
        new Date(row.created_at),
      ],
      { prepare: true }
    );
    console.log(
      `  ✓ thread=${row.thread_id}  checkpoint=${row.checkpoint_id}  channel=${row.channel}`
    );
  }

  await client.shutdown();
  console.log("\nSample data inserted successfully.");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
