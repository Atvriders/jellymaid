-- Why its own column rather than decorating `torrents.state`: `state` is a verbatim qBittorrent
-- field that a later delete guard matches against a set of busy states ("downloading",
-- "checkingUP", "moving", …) and blocks on, with no override. Appending anything to it — e.g.
-- "downloading (files unavailable: timeout)" — makes that membership test fail, so the guard
-- opens, and it opens precisely when qBittorrent is flaky. A per-scan diagnostic gets its own
-- field; a field a guard reads stays exactly as the source reported it.
ALTER TABLE torrents ADD COLUMN files_error TEXT;
