CREATE KEYSPACE IF NOT EXISTS langgraph
  WITH replication = {'class': 'NetworkTopologyStrategy', 'replication_factor': 3};

CREATE TABLE IF NOT EXISTS langgraph.checkpoints (
  thread_id            text,
  checkpoint_ns        text,
  checkpoint_id        text,
  parent_checkpoint_id text,
  checkpoint           blob,
  metadata             blob,
  source               text,
  step                 int,
  created_at           timestamp,
  PRIMARY KEY ((thread_id, checkpoint_ns), checkpoint_id)
) WITH CLUSTERING ORDER BY (checkpoint_id DESC);


CREATE TABLE IF NOT EXISTS langgraph.checkpoint_writes (
  thread_id     text,
  checkpoint_ns text,
  checkpoint_id text,
  task_id       text,
  idx           int,
  channel       text,
  type          text,
  value         blob,
  created_at    timestamp,
  PRIMARY KEY ((thread_id, checkpoint_ns, checkpoint_id), task_id, idx)
);


CREATE INDEX IF NOT EXISTS idx_checkpoints_source ON langgraph.checkpoints (source);
CREATE INDEX IF NOT EXISTS idx_checkpoints_step   ON langgraph.checkpoints (step);
