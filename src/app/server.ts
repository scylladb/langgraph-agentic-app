import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ScyllaDBSaver } from "@gbyte.tech/langgraph-checkpoint-scylladb";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { Client as CassandraClient } from "cassandra-driver";
import { buildGraph } from "../graph.js";

// ── CQL query capture ─────────────────────────────────────────────────────────
// Monkey-patch cassandra-driver's execute() to record every CQL call (query +
// result) made during a graph.invoke(), then return them for OOB rendering.

interface CqlEntry {
  query: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: Record<string, any>[] | null;
  totalRows: number;
  // Bound parameters passed to execute() — captured for INSERT display
  params: unknown[] | null;
}

let _entryPromises: Promise<CqlEntry>[] = [];
let _capturing = false;

const _origExecute = CassandraClient.prototype.execute;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(CassandraClient.prototype as any).execute = function (query: string, ...args: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const promise: Promise<any> = (_origExecute as any).apply(this, [query, ...args]);
  if (_capturing) {
    const q = String(query);
    // args[0] is the bound params array when present
    const params: unknown[] | null = Array.isArray(args[0]) ? (args[0] as unknown[]) : null;
    _entryPromises.push(
      promise
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((result: any) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rows: Record<string, any>[] = (result?.rows ?? []).slice(0, 2).map((row: any) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const obj: Record<string, any> = {};
            for (const key of Object.keys(row)) obj[key] = row[key];
            return obj;
          });
          return { query: q, rows, totalRows: result?.rows?.length ?? 0, params } satisfies CqlEntry;
        })
        .catch(() => ({ query: q, rows: null, totalRows: 0, params }) satisfies CqlEntry)
    );
  }
  return promise;
};

function startCapture() {
  _entryPromises = [];
  _capturing = true;
}

// Logical phase order for display: read → stage writes → persist checkpoint → cleanup
function queryPhase(q: string): number {
  const u = q.toUpperCase().trim();
  if (u.startsWith("SELECT")) return 0;
  if (u.startsWith("INSERT") && u.includes("CHECKPOINT_WRITES")) return 1;
  if (u.startsWith("INSERT") && u.includes("CHECKPOINTS")) return 2;
  if (u.startsWith("DELETE")) return 3;
  return 4;
}

async function stopCapture(): Promise<string[]> {
  _capturing = false;
  const entries = await Promise.all(_entryPromises.splice(0));
  entries.sort((a, b) => queryPhase(a.query) - queryPhase(b.query));
  return entries.map(renderCqlHtml);
}

// ── CQL label & render ────────────────────────────────────────────────────────

const CQL_KEYWORDS = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "FROM", "WHERE", "INTO", "VALUES",
  "IF", "NOT", "EXISTS", "AND", "OR", "SET", "ORDER", "BY", "LIMIT",
  "ALLOW", "FILTERING", "CREATE", "TABLE", "KEYSPACE", "PRIMARY", "KEY",
  "WITH", "REPLICATION", "CLASS", "FACTOR", "INDEX", "ON", "DROP", "ALTER",
  "BATCH", "BEGIN", "APPLY", "USING", "TTL", "TIMESTAMP", "IN", "ASC", "DESC",
];

function labelQuery(q: string): string {
  const u = q.toUpperCase().trim();
  if (u.startsWith("SELECT") && u.includes("CHECKPOINTS") && !u.includes("CHECKPOINT_WRITES"))
    return "Read latest checkpoint for this thread";
  if (u.startsWith("SELECT") && u.includes("CHECKPOINT_WRITES"))
    return "Read pending writes for this checkpoint";
  if (u.startsWith("SELECT"))
    return "Query ScyllaDB";
  if (u.startsWith("INSERT") && u.includes("CHECKPOINT_WRITES"))
    return "Stage node output before committing";
  if (u.startsWith("INSERT") && u.includes("CHECKPOINTS"))
    return "Persist new checkpoint to ScyllaDB";
  if (u.startsWith("INSERT"))
    return "Write row to ScyllaDB";
  if (u.startsWith("UPDATE") && u.includes("CHECKPOINTS"))
    return "Update checkpoint record";
  if (u.startsWith("DELETE") && u.includes("CHECKPOINT_WRITES"))
    return "Clean up staged writes";
  return "Execute CQL";
}

function escHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightCql(text: string): string {
  const pattern = new RegExp(`\\b(${CQL_KEYWORDS.join("|")})\\b`, "g");
  return escHtml(text).replace(pattern, '<span style="color:#59c1cc;font-weight:600">$1</span>');
}

/**
 * For INSERT queries, parse column names from the query and zip with bound params
 * to produce a synthetic result row for display.
 */
function parseInsertRow(query: string, params: unknown[]): Record<string, unknown> | null {
  const colMatch = /INSERT\s+INTO\s+\S+\s*\(([^)]+)\)/i.exec(query);
  if (!colMatch) return null;
  const cols = colMatch[1].split(",").map((c) => c.trim()).filter(Boolean);

  const valMatch = /VALUES\s*\(([^)]+)\)/i.exec(query);
  if (!valMatch) return null;
  const valTokens = valMatch[1].split(",").map((v) => v.trim());

  const row: Record<string, unknown> = {};
  let paramIdx = 0;
  for (let i = 0; i < cols.length; i++) {
    const token = valTokens[i] ?? "?";
    if (token === "?") {
      row[cols[i]] = paramIdx < params.length ? params[paramIdx++] : null;
    } else {
      // CQL function call e.g. toTimestamp(now()) — not a bound param
      row[cols[i]] = `⟨${token}⟩`;
    }
  }
  return row;
}

function renderCqlHtml(entry: CqlEntry): string {
  const { query, rows, totalRows, params } = entry;

  const highlighted = highlightCql(query);
  const time = new Date().toLocaleTimeString();
  const label = labelQuery(query);

  let resultHtml = "";
  if (rows === null) {
    resultHtml = `<div class="cql-result-none">⚠ error</div>`;
  } else if (rows.length === 0) {
    resultHtml = `<div class="cql-result-none">no rows returned</div>`;
  } else {
    const cols = Object.keys(rows[0]);
    const extra = totalRows > 2
      ? `<div class="cql-result-more">+ ${totalRows - 2} more row(s)</div>`
      : "";
    const tableRows = rows.map(row =>
      `<tr>${cols.map(c => {
        const val = row[c];
        const display = (val === null || val === undefined)
          ? `<span style="color:#6b7280">null</span>`
          : (val instanceof Buffer || (typeof val === "object"))
            ? `<span style="color:#6b7280">[blob]</span>`
            : escHtml(String(val));
        return `<td>${display}</td>`;
      }).join("")}</tr>`
    ).join("");
    resultHtml =
      `<div class="cql-result-wrap">` +
      `<table class="cql-result-table">` +
      `<thead><tr>${cols.map(c => `<th>${escHtml(c)}</th>`).join("")}</tr></thead>` +
      `<tbody>${tableRows}</tbody>` +
      `</table>${extra}</div>`;
  }

  // For INSERT queries, replace the empty "no rows returned" fallback with the
  // bound params rendered as a synthetic inserted-row table.
  const isInsert = query.toUpperCase().trimStart().startsWith("INSERT");
  if (isInsert && params !== null && rows !== null && rows.length === 0) {
    const parsed = parseInsertRow(query, params);
    if (parsed) {
      const insertCols = Object.keys(parsed);
      const tableRow = `<tr>${insertCols.map((c) => {
        const val = parsed[c];
        const display =
          val === null || val === undefined
            ? `<span style="color:#6b7280">null</span>`
            : val instanceof Buffer || (typeof val === "object" && typeof val !== "string" && !String(val).startsWith("\u27e8"))
              ? `<span style="color:#6b7280">[blob]</span>`
              : escHtml(String(val));
        return `<td>${display}</td>`;
      }).join("")}</tr>`;
      resultHtml =
        `<div class="cql-result-wrap">` +
        `<table class="cql-result-table">` +
        `<thead><tr>${insertCols.map((c) => `<th>${escHtml(c)}</th>`).join("")}</tr></thead>` +
        `<tbody>${tableRow}</tbody>` +
        `</table></div>`;
    }
  }

  return (
    `<div class="cql-entry">` +
    `<span class="cql-time">${time}</span>` +
    `<div class="cql-label">${escHtml(label)}</div>` +
    `<pre class="cql-pre">${highlighted}</pre>` +
    resultHtml +
    `</div>`
  );
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATES_DIR = path.join(__dirname, "templates");
const schemaHtml = highlightCql(readFileSync(path.join(__dirname, "../../schema.cql"), "utf8"));
const PUBLIC_DIR = path.join(__dirname, "public");

// ── Thread metadata store (in-memory for demo) ────────────────────────────────
// ScyllaDB durably stores the message checkpoints; this map tracks display names
// for sidebar rendering. Threads survive server restarts in ScyllaDB but sidebar
// names reset on server restart (acceptable for a demo).

interface ThreadMeta {
  title: string;
  createdAt: Date;
}

const threads = new Map<string, ThreadMeta>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Send one message to the graph and return the AI's text reply. */
async function chat(
  graph: ReturnType<typeof buildGraph>,
  threadId: string,
  userText: string
): Promise<string> {
  const result = await graph.invoke(
    { messages: [new HumanMessage(userText)] },
    { configurable: { thread_id: threadId } }
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const last = result.messages.at(-1) as any;
  return typeof last?.content === "string"
    ? last.content
    : JSON.stringify(last?.content ?? "(no response)");
}

/** Get all messages for a thread by reading the latest graph state snapshot. */
async function getMessages(
  graph: ReturnType<typeof buildGraph>,
  threadId: string
): Promise<{ role: "human" | "ai" | "other"; content: string }[]> {
  const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
  const messages: BaseMessage[] = (snapshot.values as { messages?: BaseMessage[] }).messages ?? [];
  return messages
    .filter((m) => m.getType() === "human" || m.getType() === "ai")
    .map((m) => ({
      role: m.getType() as "human" | "ai",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
}

// ── App setup ─────────────────────────────────────────────────────────────────

async function startServer() {
  // Validate required environment variables
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

  console.log(`Connecting to ScyllaDB Cloud at ${host} …`);

  const scyllaSaver = await ScyllaDBSaver.fromConfig({
    contactPoints: [host],
    localDataCenter: dc,
    keyspace: "langgraph",
    credentials: { username, password },
    ttlConfig: { defaultTTLSeconds: 86400 },
  });

  const graph = buildGraph(scyllaSaver);

  // ── Express ──────────────────────────────────────────────────────────────

  const app = express();

  app.set("view engine", "ejs");
  app.set("views", TEMPLATES_DIR);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use("/public", express.static(PUBLIC_DIR));

  // ── Routes ────────────────────────────────────────────────────────────────

  /** Home: redirect to first thread or show empty state */
  app.get("/", (_req, res) => {
    const firstId = threads.keys().next().value as string | undefined;
    if (firstId) {
      res.redirect(`/threads/${firstId}`);
    } else {
      res.render("index", {
        threads: [],
        activeThreadId: null,
        activeTitle: null,
        messages: [],
        cqlQueries: [],
        schemaHtml,
      });
    }
  });

  /** Create a new thread */
  app.post("/threads", (_req, res) => {
    const threadId = crypto.randomUUID();
    threads.set(threadId, { title: "New chat", createdAt: new Date() });
    res.redirect(`/threads/${threadId}`);
  });

  /** View a thread */
  app.get("/threads/:id", async (req, res) => {
    const { id } = req.params;

    // Auto-register thread if accessed directly (e.g. from ScyllaDB-persisted session)
    if (!threads.has(id)) {
      threads.set(id, { title: `Thread ${id.slice(0, 8)}`, createdAt: new Date() });
    }

    try {
      startCapture();
      const messages = await getMessages(graph, id);
      const cqlQueries = await stopCapture();
      res.render("index", {
        threads: [...threads.entries()].map(([tid, meta]) => ({ id: tid, ...meta })),
        activeThreadId: id,
        activeTitle: threads.get(id)!.title,
        messages,
        cqlQueries,
        schemaHtml,
      });
    } catch (err) {
      await stopCapture();
      console.error("Error loading thread:", err);
      res.status(500).send("Failed to load thread history.");
    }
  });

  /** Send a message — returns an HTML partial that htmx appends */
  app.post("/threads/:id/messages", async (req, res) => {
    const { id } = req.params;
    const userText: string = (req.body.message ?? "").trim();

    if (!userText) {
      res.status(400).send("Message cannot be empty.");
      return;
    }

    // Auto-register thread (defensive)
    if (!threads.has(id)) {
      threads.set(id, { title: userText.slice(0, 40), createdAt: new Date() });
    } else {
      // Update title to first message if still the default
      const meta = threads.get(id)!;
      if (meta.title === "New chat") {
        meta.title = userText.slice(0, 40);
      }
    }

    try {
      startCapture();
      const aiReply = await chat(graph, id, userText);
      const cqlQueries = await stopCapture();
      res.render("partials/message-pair", { userText, aiReply, cqlQueries });
    } catch (err) {
      await stopCapture();
      console.error("Error calling chat:", err);
      res.status(500).send("Failed to get a response.");
    }
  });

  // ── Start ─────────────────────────────────────────────────────────────────

  const PORT = process.env.PORT ?? "3000";
  app.listen(parseInt(PORT, 10), () => {
    console.log(`\nChat UI ready → http://localhost:${PORT}\n`);
  });
}

startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
