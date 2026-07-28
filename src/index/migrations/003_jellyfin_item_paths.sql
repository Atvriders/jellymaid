-- One row per physical file behind a Jellyfin item, not just its primary path. `jellyfin_items`
-- stores exactly one container_path per item (the top-level `Path` the /Items API returns), which
-- is only the primary version once two items have been merged via Merge Versions — this product's
-- own chosen duplicate-resolution action. From that point on, /Items?Recursive=true no longer
-- returns the alternate version as its own item row; it survives only inside the surviving item's
-- MediaSources[]. Without this table, fs.orphan-media cannot tell that alternate file apart from a
-- genuine orphan and reports it as one, at 'exact' confidence, with its full size reclaimable — a
-- live path to the operator deleting the file they just told Jellyfin to keep.
--
-- PRIMARY KEY (item_id, jf_path), not just item_id: an item legitimately has more than one path
-- (one per merged version).
CREATE TABLE jellyfin_item_paths (
  item_id        TEXT NOT NULL,
  scan_id        INTEGER NOT NULL,
  jf_path        TEXT NOT NULL,
  container_path TEXT,
  PRIMARY KEY (item_id, jf_path)
);
CREATE INDEX idx_jellyfin_item_paths_container ON jellyfin_item_paths (container_path);
