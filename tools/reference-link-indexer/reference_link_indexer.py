#!/usr/bin/env python3
"""
BubblesEdiy Cinema AI — reference-link indexer (consolidated).

You sent several near-identical scripts targeting 10,000 / 50,000 / 100,000 /
10,000,000 / 10,000,000,000 / 10,000,000,000,000,000,000 links. They all did the
same thing: page through Internet Archive's public metadata search, dedupe by
identifier, and write TXT/CSV/SQLite output. This file replaces all of them with
one tool. The --target number was always a configuration ceiling, never a claim
that this many links exist or were collected — keep treating it that way.

Reality check, stated once instead of six times:
- Internet Archive alone will not get you anywhere near billions of unique,
  relevant, rights-clear video links. Nothing will. Pick a target you can
  actually review item-by-item for license and AI-training permission —
  hundreds or low thousands is realistic for a curated starter dataset.
- Every link produced is an item PAGE, not a guaranteed direct video file.
- Public accessibility is never, by itself, permission to download, train on,
  or commercially reuse something. Check each item's actual license.
- This script indexes metadata only. It does not download video files, bypass
  access controls, or scrape disallowed content.
- It could not reach archive.org from the sandbox this was written in
  (outbound access there is restricted to an allowlist). Run it from your own
  machine, where it talks to the real Internet Archive Advanced Search API.

Usage:
    python reference_link_indexer.py --target 2000
    python reference_link_indexer.py --target 2000 --query-file queries.txt
    python reference_link_indexer.py --import-jsonl authorized_catalog_export.jsonl

JSONL import format (for any OTHER authorized catalog/export, one object per line):
    {"title": "...", "url": "https://...", "source": "...", "license_url": "...",
     "ai_training_permission": "unknown", "media_type": "movies"}
Do not fabricate URLs for import — only feed it real exports from a catalog whose
terms you've checked.
"""
import argparse
import csv
import json
import sqlite3
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Optional

IA_API = "https://archive.org/advancedsearch.php"
IA_FIELDS = ["identifier", "title", "mediatype", "licenseurl", "collection", "date"]
DEFAULT_QUERIES = [
    "mediatype:movies AND collection:opensource_movies",
    "mediatype:movies AND collection:prelinger",
    "mediatype:movies AND collection:feature_films",
    "mediatype:movies AND collection:animationandcartoons",
    "mediatype:movies AND collection:classic_tv",
    "mediatype:movies AND collection:ephemera",
    "mediatype:movies AND collection:stock_footage",
    "mediatype:movies AND collection:artsandmusicvideos",
    "mediatype:movies AND collection:community_video",
    "mediatype:movies AND collection:filmchest",
    "mediatype:movies AND collection:classic_cartoons",
    "mediatype:movies AND collection:opensource",
    "mediatype:movies AND collection:newsandpublicaffairs",
]
# A single Advanced Search query is capped at 10,000 offset results by the API itself.
IA_OFFSET_CAP = 10_000


def open_db(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.execute(
        """CREATE TABLE IF NOT EXISTS links (
            url TEXT PRIMARY KEY, title TEXT, source TEXT, source_id TEXT,
            license_url TEXT, ai_training_permission TEXT, media_type TEXT,
            metadata_json TEXT, added_at TEXT DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    db.commit()
    return db


def add_record(db: sqlite3.Connection, rec: dict) -> bool:
    """Insert one record if its URL is new. Returns True if it was actually added."""
    url = str(rec.get("url", "")).strip()
    if not url.startswith(("https://", "http://")):
        return False
    before = db.total_changes
    db.execute(
        """INSERT OR IGNORE INTO links
           (url,title,source,source_id,license_url,ai_training_permission,media_type,metadata_json)
           VALUES(?,?,?,?,?,?,?,?)""",
        (
            url,
            str(rec.get("title", "")).replace("\n", " ").strip(),
            str(rec.get("source", "unknown")),
            str(rec.get("source_id", "")),
            str(rec.get("license_url", "")),
            str(rec.get("ai_training_permission", "unknown")),
            str(rec.get("media_type", "")),
            json.dumps(rec.get("metadata", {}), ensure_ascii=False),
        ),
    )
    return db.total_changes > before


def fetch_ia_page(query: str, start: int, rows: int) -> list:
    """One page of Internet Archive Advanced Search results. Network call — the
    function exists on its own so tests can substitute a fake without touching
    the real API."""
    params = [("q", query), ("output", "json"), ("rows", str(rows)), ("start", str(start))]
    params.extend(("fl[]", field) for field in IA_FIELDS)
    url = IA_API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "BubblesEdiyCinemaAI-LinkIndexer/2.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("responseHeader", {}).get("status") != 0:
        raise RuntimeError("Internet Archive search API returned an unsuccessful response")
    return payload.get("response", {}).get("docs", [])


def index_internet_archive(
    db: sqlite3.Connection,
    target: int,
    queries: list[str],
    pause: float,
    fetch_page: Callable[[str, int, int], list] = fetch_ia_page,
    log: Callable[[str], None] = print,
) -> int:
    count = db.execute("SELECT COUNT(*) FROM links").fetchone()[0]
    for query in queries:
        if count >= target:
            break
        start = 0
        log(f"Query: {query}")
        while start < IA_OFFSET_CAP and count < target:
            try:
                docs = fetch_page(query, start, min(100, target - count))
            except Exception as exc:  # noqa: BLE001 — surfaced to the user, not swallowed
                log(f"  API error at offset {start}: {exc}. Stopping this query.")
                break
            if not docs:
                break
            for doc in docs:
                ident = str(doc.get("identifier", "")).strip()
                if not ident:
                    continue
                collection = doc.get("collection", [])
                if isinstance(collection, list):
                    collection = "; ".join(str(x) for x in collection)
                add_record(
                    db,
                    {
                        "title": doc.get("title", ""),
                        "url": "https://archive.org/details/" + urllib.parse.quote(ident, safe=""),
                        "source": "Internet Archive",
                        "source_id": ident,
                        "license_url": doc.get("licenseurl", ""),
                        "ai_training_permission": "unknown — verify item-specific rights",
                        "media_type": doc.get("mediatype", ""),
                        "metadata": {"date": doc.get("date", ""), "collection": collection, "query": query},
                    },
                )
            db.commit()
            count = db.execute("SELECT COUNT(*) FROM links").fetchone()[0]
            start += len(docs)
            log(f"  {count:,}/{target:,} unique links indexed")
            if start < IA_OFFSET_CAP and count < target:
                time.sleep(max(0, pause))
    return count


def import_jsonl(db: sqlite3.Connection, path: Path, log: Callable[[str], None] = print) -> int:
    added = 0
    with Path(path).open(encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                log(f"Skipping invalid JSON on line {line_no}")
                continue
            if add_record(db, rec):
                added += 1
            if added and added % 1000 == 0:
                db.commit()
                log(f"Imported {added:,} new records so far")
    db.commit()
    return added


def export_shards(db: sqlite3.Connection, out_dir: Path, shard_size: int) -> int:
    total = db.execute("SELECT COUNT(*) FROM links").fetchone()[0]
    offset, shard = 0, 1
    cols = "title,url,source,source_id,license_url,ai_training_permission,media_type,metadata_json"
    while offset < total:
        rows = db.execute(
            f"SELECT {cols} FROM links ORDER BY url LIMIT ? OFFSET ?", (shard_size, offset)
        ).fetchall()
        if not rows:
            break
        txt_path = out_dir / f"video_links_{shard:05d}.txt"
        csv_path = out_dir / f"video_links_{shard:05d}.csv"
        with txt_path.open("w", encoding="utf-8") as f:
            f.write("BubblesEdiy Cinema AI — individual item-page links\n")
            f.write("Not guaranteed direct video files. Verify license and AI-training permission per item.\n\n")
            for title, url, *_ in rows:
                f.write(f"{title or url}\n{url}\n\n")
        with csv_path.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(cols.split(","))
            w.writerows(rows)
        offset += len(rows)
        shard += 1
    return total


def load_queries(query_file: Optional[str]) -> list[str]:
    if query_file:
        return [
            line.strip()
            for line in Path(query_file).read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
    return DEFAULT_QUERIES


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--target", type=int, default=2000, help="Stop once this many unique links are indexed (default 2000 — a realistic, reviewable starter size).")
    p.add_argument("--out-dir", default="bubblesediy_reference_links")
    p.add_argument("--query-file", default="", help="One Internet Archive Advanced Search query per line; default uses a built-in set of open-film/animation collections.")
    p.add_argument("--import-jsonl", default="", help="Import an authorized catalog export instead of querying Internet Archive.")
    p.add_argument("--shard-size", type=int, default=5000)
    p.add_argument("--pause", type=float, default=0.25, help="Seconds between API pages, to stay polite to the service.")
    args = p.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    db = open_db(out_dir / "index.sqlite3")

    if args.import_jsonl:
        added = import_jsonl(db, Path(args.import_jsonl))
        print(f"Imported {added:,} new records from {args.import_jsonl} (duplicates ignored).")
    else:
        queries = load_queries(args.query_file or None)
        count = index_internet_archive(db, args.target, queries, args.pause)
        if count < args.target:
            print(f"Reached {count:,}/{args.target:,}. The configured queries ran out of results; "
                  "add more in a --query-file or import another authorized catalog with --import-jsonl.")

    total = export_shards(db, out_dir, max(100, args.shard_size))
    print(f"\nTotal unique item-page links stored: {total:,}")
    print(f"Database: {(out_dir / 'index.sqlite3').resolve()}")
    print(f"Output directory: {out_dir.resolve()}")
    print("These are item pages, not confirmed direct video files, and are not pre-cleared for AI training.")


if __name__ == "__main__":
    main()
