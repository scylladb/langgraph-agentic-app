# LangGraph + ScyllaDB Cloud Demo

Multi-turn customer support chatbot using [LangGraph](https://langchain-ai.github.io/langgraphjs/) with [ScyllaDB Cloud](https://cloud.scylladb.com) as the checkpoint store. Demonstrates that conversation state survives across independent requests — and why ScyllaDB is a better fit for AI workloads than Redis.

## Prerequisites

- Node.js 18+
- A [Groq](https://console.groq.com/keys) API key
- A [ScyllaDB Cloud](https://cloud.scylladb.com) cluster (free trial available)

## Setup

### 1. ScyllaDB Cloud

1. Log in at [cloud.scylladb.com](https://cloud.scylladb.com) and create a cluster (or use an existing one).
2. Go to **My Clusters → \<your cluster\> → Connect → Node.js**.
3. Note your **contact point hostname**, **data center name**, and **password**.
4. Under the **General** tab, add your machine's IP to the allowed IPs list.

### 2. Environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in the five values:

| Variable | Where to find it |
|---|---|
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) |
| `SCYLLADB_HOST` | Connect tab → one of the `node-N.…clusters.scylla.cloud` hostnames |
| `SCYLLADB_DC` | Connect tab → `localDataCenter` value (e.g. `AWS_US_EAST_1`) |
| `SCYLLADB_USERNAME` | Connect tab (default: `scylla`) |
| `SCYLLADB_PASSWORD` | Connect tab → Instructions section |

### 3. Install dependencies

```bash
npm install
```

### 4. Create the schema

Run the migration script once to create the `langgraph` keyspace and the `checkpoints` / `checkpoint_writes` tables in your ScyllaDB Cloud cluster:

```bash
npm run migrate
```

> You only need to do this once. Re-running it is safe — all statements use `IF NOT EXISTS`.

## Run
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The UI has three panels:

- **Left sidebar** — thread list and "New Chat" button. Thread titles are kept in memory only; they reset on server restart, but the underlying conversation checkpoints stored in ScyllaDB survive and reload automatically when you revisit the same URL.
- **Centre** — chat window.
- **Right panel** — live CQL feed. Every query issued to ScyllaDB during a `graph.invoke()` call is captured and displayed here: the raw CQL statement, bound parameters, and the result rows (or `no rows returned`).

## Project structure

```
src/
  graph.ts      — LangGraph StateGraph definition and buildGraph() factory
  demo.ts       — Demo runner (Sections A, B, C)
  migrate.ts    — Schema migration script (npm run migrate)
  sample.ts     — Sample data seeder (npm run sample)
  app/
    server.ts             — Express server (chat UI backend)
    templates/
      index.ejs           — Page shell (sidebar + chat area + CQL panel)
      partials/
        sidebar.ejs       — Thread list + New Chat button
        chat.ejs          — Message scroll area + input form
        message-pair.ejs  — htmx fragment: user + AI bubbles
        right-panel.ejs   — Live CQL feed + schema viewer
schema.cql   — Keyspace and table definitions applied by npm run migrate
.env.example — Required environment variables template
```

## Available scripts

| Command | Description |
|---|---|
| `npm start` | Run the CLI demo (Sections A, B, C) |
| `npm run dev` | Start the Express chat UI on port 3000 |
| `npm run migrate` | Apply `schema.cql` to your ScyllaDB cluster (run once before first use) |
| `npm run sample` | Seed sample checkpoint rows from `data/*.csv` |
