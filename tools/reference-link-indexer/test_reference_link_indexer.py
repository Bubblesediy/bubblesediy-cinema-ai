"""
Tests for the consolidated reference-link indexer. These never touch the real
network: Internet Archive calls are replaced with a fake in-memory responder,
matching the shape of the real Advanced Search API.

Run with: pytest -q
"""
import csv
import json
import tempfile
from pathlib import Path

import reference_link_indexer as idx


def make_fake_fetch(pages_by_query):
    """pages_by_query: {query: [[doc,...], [doc,...], ...]} one list of docs per page."""
    calls = {"n": 0}

    def fetch(query, start, rows):
        calls["n"] += 1
        pages = pages_by_query.get(query, [])
        page_index = start // 100
        if page_index >= len(pages):
            return []
        return pages[page_index]

    fetch.calls = calls
    return fetch


def doc(ident, title="A Film", collection="opensource_movies"):
    return {"identifier": ident, "title": title, "mediatype": "movies", "licenseurl": "", "collection": [collection], "date": "2020"}


def test_add_record_rejects_non_http_urls():
    with tempfile.TemporaryDirectory() as d:
        db = idx.open_db(Path(d) / "t.sqlite3")
        assert idx.add_record(db, {"url": "ftp://example.org/x"}) is False
        assert idx.add_record(db, {"url": ""}) is False
        assert idx.add_record(db, {"url": "https://example.org/x"}) is True


def test_add_record_deduplicates_by_url():
    with tempfile.TemporaryDirectory() as d:
        db = idx.open_db(Path(d) / "t.sqlite3")
        rec = {"url": "https://archive.org/details/foo", "title": "Foo"}
        assert idx.add_record(db, rec) is True
        assert idx.add_record(db, rec) is False  # second insert is a no-op
        total = db.execute("SELECT COUNT(*) FROM links").fetchone()[0]
        assert total == 1


def test_index_internet_archive_stops_at_target():
    fake = make_fake_fetch({
        "q1": [[doc("a1"), doc("a2")], [doc("a3")]],
        "q2": [[doc("b1"), doc("b2")]],
    })
    with tempfile.TemporaryDirectory() as d:
        db = idx.open_db(Path(d) / "t.sqlite3")
        count = idx.index_internet_archive(db, target=3, queries=["q1", "q2"], pause=0, fetch_page=fake, log=lambda s: None)
        assert count == 3
        urls = [r[0] for r in db.execute("SELECT url FROM links").fetchall()]
        assert len(urls) == 3


def test_index_internet_archive_moves_to_next_query_when_exhausted():
    fake = make_fake_fetch({
        "q1": [[doc("a1")]],   # only one doc, then empty
        "q2": [[doc("b1"), doc("b2")]],
    })
    with tempfile.TemporaryDirectory() as d:
        db = idx.open_db(Path(d) / "t.sqlite3")
        count = idx.index_internet_archive(db, target=3, queries=["q1", "q2"], pause=0, fetch_page=fake, log=lambda s: None)
        assert count == 3  # a1 + b1 + b2


def test_index_internet_archive_handles_api_errors_gracefully():
    def failing_fetch(query, start, rows):
        raise RuntimeError("simulated network failure")

    with tempfile.TemporaryDirectory() as d:
        db = idx.open_db(Path(d) / "t.sqlite3")
        count = idx.index_internet_archive(db, target=10, queries=["q1"], pause=0, fetch_page=failing_fetch, log=lambda s: None)
        assert count == 0  # no crash, just stops with what it has (nothing)


def test_import_jsonl_skips_invalid_lines_and_dedupes(tmp_path=None):
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        jsonl = d / "catalog.jsonl"
        jsonl.write_text(
            '{"url": "https://example.org/1", "title": "One"}\n'
            "not valid json\n"
            '{"url": "https://example.org/1", "title": "Duplicate"}\n'
            '{"url": "https://example.org/2", "title": "Two"}\n',
            encoding="utf-8",
        )
        db = idx.open_db(d / "t.sqlite3")
        added = idx.import_jsonl(db, jsonl, log=lambda s: None)
        assert added == 2
        total = db.execute("SELECT COUNT(*) FROM links").fetchone()[0]
        assert total == 2


def test_export_shards_writes_txt_and_csv_with_all_records():
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        db = idx.open_db(d / "t.sqlite3")
        for i in range(7):
            idx.add_record(db, {"url": f"https://example.org/{i}", "title": f"Film {i}"})
        total = idx.export_shards(db, d, shard_size=3)
        assert total == 7
        txt_files = sorted(d.glob("video_links_*.txt"))
        csv_files = sorted(d.glob("video_links_*.csv"))
        assert len(txt_files) == 3  # 3 + 3 + 1
        assert len(csv_files) == 3
        all_csv_rows = []
        for cf in csv_files:
            with cf.open(encoding="utf-8") as f:
                all_csv_rows.extend(list(csv.DictReader(f)))
        assert len(all_csv_rows) == 7
        assert all(row["url"].startswith("https://example.org/") for row in all_csv_rows)


def test_export_shards_on_empty_db_writes_nothing():
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        db = idx.open_db(d / "t.sqlite3")
        total = idx.export_shards(db, d, shard_size=100)
        assert total == 0
        assert list(d.glob("video_links_*.txt")) == []


def test_load_queries_from_file_ignores_blank_and_comment_lines():
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        qf = d / "queries.txt"
        qf.write_text("# comment\nmediatype:movies\n\n  mediatype:movies AND collection:prelinger  \n", encoding="utf-8")
        queries = idx.load_queries(str(qf))
        assert queries == ["mediatype:movies", "mediatype:movies AND collection:prelinger"]


def test_load_queries_defaults_when_no_file():
    assert idx.load_queries(None) == idx.DEFAULT_QUERIES
    assert len(idx.DEFAULT_QUERIES) > 0
