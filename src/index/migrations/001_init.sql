CREATE TABLE scans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,           -- running | completed | cancelled | failed
  phase         TEXT,                    -- jellyfin | filesystem | qbittorrent | arr | rules | reconcile
  cursor_json   TEXT NOT NULL DEFAULT '{}',
  stats_json    TEXT NOT NULL DEFAULT '{}',
  error         TEXT
);

CREATE TABLE jellyfin_items (
  id                TEXT PRIMARY KEY,
  scan_id           INTEGER NOT NULL,
  type              TEXT NOT NULL,
  name              TEXT NOT NULL,
  sort_name         TEXT,
  year              INTEGER,
  series_id         TEXT,
  series_name       TEXT,
  season_no         INTEGER,
  episode_no        INTEGER,
  provider_ids_json TEXT NOT NULL DEFAULT '{}',
  jf_path           TEXT,
  container_path    TEXT,
  size_bytes        INTEGER,
  runtime_ticks     INTEGER,
  container         TEXT,
  video_codec       TEXT,
  audio_codec       TEXT,
  audio_channels    INTEGER,
  width             INTEGER,
  height            INTEGER,
  bitrate           INTEGER,
  has_primary_image INTEGER NOT NULL DEFAULT 0,
  library_id        TEXT,
  library_name      TEXT,
  date_created      TEXT,
  media_source_id   TEXT
);
CREATE INDEX idx_jellyfin_items_container_path ON jellyfin_items (container_path);
CREATE INDEX idx_jellyfin_items_episode ON jellyfin_items (series_id, season_no, episode_no);
CREATE INDEX idx_jellyfin_items_scan ON jellyfin_items (scan_id);

CREATE TABLE fs_entries (
  container_path TEXT PRIMARY KEY,
  scan_id        INTEGER NOT NULL,
  parent_path    TEXT NOT NULL,
  name           TEXT NOT NULL,
  ext            TEXT,
  is_dir         INTEGER NOT NULL,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  mtime          INTEGER NOT NULL DEFAULT 0,
  dev            INTEGER NOT NULL DEFAULT 0,
  inode          INTEGER NOT NULL DEFAULT 0,
  nlink          INTEGER NOT NULL DEFAULT 1,
  is_media       INTEGER NOT NULL DEFAULT 0,
  library_root   TEXT,
  root_role      TEXT,                   -- library | download
  quick_hash     TEXT
);
CREATE INDEX idx_fs_entries_inode ON fs_entries (dev, inode);
CREATE INDEX idx_fs_entries_parent ON fs_entries (parent_path);
CREATE INDEX idx_fs_entries_root ON fs_entries (library_root, is_media);
CREATE INDEX idx_fs_entries_hash ON fs_entries (quick_hash) WHERE quick_hash IS NOT NULL;

CREATE TABLE torrents (
  hash                   TEXT PRIMARY KEY,
  fetched_at             TEXT NOT NULL,
  name                   TEXT NOT NULL,
  save_path              TEXT,
  content_path           TEXT,
  container_content_path TEXT,
  category               TEXT,
  tags                   TEXT,
  state                  TEXT,
  ratio                  REAL,
  seeding_time           INTEGER,
  is_private             INTEGER,
  tracker_host           TEXT,
  size_bytes             INTEGER,
  progress               REAL
);

CREATE TABLE torrent_files (
  hash           TEXT NOT NULL,
  file_index     INTEGER NOT NULL,
  rel_path       TEXT NOT NULL,
  container_path TEXT,
  size_bytes     INTEGER,
  dev            INTEGER,
  inode          INTEGER,
  PRIMARY KEY (hash, file_index)
);
CREATE INDEX idx_torrent_files_inode ON torrent_files (dev, inode);
CREATE INDEX idx_torrent_files_path ON torrent_files (container_path);

CREATE TABLE arr_records (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,          -- radarr | sonarr
  instance        TEXT NOT NULL,
  remote_id       INTEGER NOT NULL,
  title           TEXT NOT NULL,
  arr_path        TEXT,
  container_path  TEXT,
  monitored       INTEGER NOT NULL DEFAULT 1,
  series_id       INTEGER,
  episode_id      INTEGER,
  episode_file_id INTEGER
);
CREATE INDEX idx_arr_records_path ON arr_records (container_path);

CREATE TABLE findings (
  id                TEXT PRIMARY KEY,
  rule_id           TEXT NOT NULL,
  class             TEXT NOT NULL,
  severity          TEXT NOT NULL,
  confidence        TEXT NOT NULL,
  subjects_json     TEXT NOT NULL,
  evidence_json     TEXT NOT NULL,
  reclaimable_bytes INTEGER,
  status            TEXT NOT NULL,        -- open | dismissed | resolved
  first_seen        TEXT NOT NULL,
  last_seen         TEXT NOT NULL,
  dismissed_reason  TEXT,
  dismissed_by      TEXT,
  dismissed_at      TEXT
);
CREATE INDEX idx_findings_class_status ON findings (class, status);
CREATE INDEX idx_findings_rule ON findings (rule_id);

-- One row per rule per scan. This is how "not evaluated" is distinguished from "zero findings".
CREATE TABLE rule_runs (
  scan_id   INTEGER NOT NULL,
  rule_id   TEXT NOT NULL,
  status    TEXT NOT NULL,                -- evaluated | not-evaluated
  reason    TEXT,
  found     INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  PRIMARY KEY (scan_id, rule_id)
);

CREATE TABLE dupe_groups (
  id             TEXT PRIMARY KEY,
  tier           TEXT NOT NULL,
  members_json   TEXT NOT NULL,
  keeper_item_id TEXT,
  scores_json    TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE plans (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  status        TEXT NOT NULL,            -- draft | approved | running | completed | failed
  dry_run_json  TEXT NOT NULL DEFAULT '{}',
  approved_at   TEXT,
  approved_by   TEXT,
  started_at    TEXT,
  finished_at   TEXT
);

CREATE TABLE plan_actions (
  id                  TEXT PRIMARY KEY,
  plan_id             TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,
  type                TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  guard_verdicts_json TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL,
  started_at          TEXT,
  finished_at         TEXT,
  error               TEXT,
  result_json         TEXT,
  override_by         TEXT,
  override_reason     TEXT
);
CREATE INDEX idx_plan_actions_plan ON plan_actions (plan_id, seq);

CREATE TABLE audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL,
  actor          TEXT NOT NULL,
  action_type    TEXT NOT NULL,
  subject        TEXT NOT NULL,
  before_json    TEXT,
  after_json     TEXT,
  outcome        TEXT NOT NULL,
  plan_id        TEXT,
  plan_action_id TEXT
);
CREATE INDEX idx_audit_ts ON audit (ts DESC);

CREATE TABLE trash (
  id            TEXT PRIMARY KEY,
  original_path TEXT NOT NULL,
  trash_path    TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  deleted_at    TEXT NOT NULL,
  purge_after   TEXT NOT NULL,
  restored_at   TEXT,
  plan_id       TEXT
);

CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
