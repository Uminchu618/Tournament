CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  access_subject TEXT UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tournaments (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
  published_revision INTEGER,
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version >= 1),
  last_mutation_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES operators(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  archived_at TEXT,
  FOREIGN KEY (id, draft_revision) REFERENCES tournament_revisions(tournament_id, revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (id, published_revision) REFERENCES tournament_revisions(tournament_id, revision) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE tournament_revisions (
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) DEFERRABLE INITIALLY DEFERRED,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  schema_version INTEGER NOT NULL DEFAULT 1,
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  mutation_id TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES operators(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tournament_id, revision)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  tournament_id TEXT REFERENCES tournaments(id),
  actor_id TEXT NOT NULL REFERENCES operators(id),
  action TEXT NOT NULL,
  revision INTEGER,
  mutation_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  result_lock_version INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX tournaments_updated ON tournaments(updated_at DESC, id);
CREATE INDEX audit_tournament_time ON audit_events(tournament_id, created_at);
CREATE INDEX revision_created ON tournament_revisions(created_at);
