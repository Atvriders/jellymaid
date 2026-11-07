-- Multi-instance qBittorrent. A torrent's identity becomes (instance_id, hash): two boxes can seed
-- the same infohash (the owner's two real instances share ten), and each copy is a separate torrent
-- with its own files, its own state and its own delete.
--
-- torrents/torrent_files are a per-scan CACHE of what qBittorrent reported, rewritten wholesale by
-- every qBittorrent phase. Their old rows carry no instance and cannot be attributed to one after
-- the fact, so they are dropped rather than guessed at; the next scan repopulates them.
DROP TABLE IF EXISTS torrent_files;
DROP TABLE IF EXISTS torrents;
CREATE TABLE torrents (
  instance_id            TEXT NOT NULL,
  hash                   TEXT NOT NULL,
  fetched_at             TEXT NOT NULL,
  name                   TEXT NOT NULL,
  save_path              TEXT,
  content_path           TEXT,
  root_path              TEXT,
  container_content_path TEXT,
  category               TEXT,
  tags                   TEXT,
  state                  TEXT,
  ratio                  REAL,
  seeding_time           INTEGER,
  is_private             INTEGER,
  tracker_host           TEXT,
  size_bytes             INTEGER,
  progress               REAL,
  added_on               INTEGER,
  files_error            TEXT,
  PRIMARY KEY (instance_id, hash)
);
-- dev/inode stay nullable with no default, exactly as 001 documents: unknown is NULL, never a
-- matchable 0/0.
CREATE TABLE torrent_files (
  instance_id    TEXT NOT NULL,
  hash           TEXT NOT NULL,
  file_index     INTEGER NOT NULL,
  rel_path       TEXT NOT NULL,
  container_path TEXT,
  size_bytes     INTEGER,
  dev            INTEGER,
  inode          INTEGER,
  PRIMARY KEY (instance_id, hash, file_index)
);
CREATE INDEX idx_torrent_files_inode ON torrent_files (dev, inode);
CREATE INDEX idx_torrent_files_path ON torrent_files (container_path);
-- Every container path a plan deleted, so read models can hide it at once instead of waiting for
-- the next scan to notice; a later Jellyfin pass that no longer lists the path clears the row.
CREATE TABLE deleted_paths (
  container_path TEXT PRIMARY KEY,
  plan_id        TEXT NOT NULL,
  deleted_at     TEXT NOT NULL
);
-- Why a background plan run failed, for the operator who is no longer holding the HTTP request.
ALTER TABLE plans ADD COLUMN error TEXT;
