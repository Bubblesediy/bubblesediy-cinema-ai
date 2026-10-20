# Reference link indexer (consolidated)

You sent six versions of the same script targeting 10,000 / 50,000 / 100,000 /
10,000,000 / 10,000,000,000 / 10,000,000,000,000,000,000 links, plus a
`BubblesEdiy_10000_Video_Link_Research_List.txt` and a
`BubblesEdiy_500_Individual_Video_Links.txt` that were mostly `[ADD VERIFIED
INDIVIDUAL VIDEO URL]` placeholders. This folder replaces all of them with one
tool, `reference_link_indexer.py`, plus real tests (`pytest -q` — 10 passing,
no network required; they substitute a fake API responder).

## What changed from the six originals
- One script instead of six near-duplicates.
- `--target` now defaults to **2,000**, not millions or billions. A target that
  large was never collected by any of the original scripts either — it was
  always just the `--target` number you'd pass in, and the honest ceiling for
  something you can actually review item-by-item is in the hundreds to low
  thousands, not billions. You can still pass a bigger `--target`; it just
  won't get you further than Internet Archive's own catalog actually has.
- The core logic (Internet Archive Advanced Search adapter, SQLite dedup,
  JSONL import for other authorized catalogs, sharded TXT/CSV export) is
  unchanged and still does not fabricate URLs, download video files, or bypass
  access controls.

## Why it isn't wired into the Cinema AI web app
This is a standalone research tool for building a reference dataset — it has
nothing to do with authenticating users or rendering films. It runs on your
own machine, writes files to your own disk, and isn't something a web app
backend should be making outbound bulk-scraping calls on behalf of a browser
session. Keep it separate and feed its *output* (a reviewed, rights-checked
JSONL/CSV of sources) into the Training Studio module described in your
original spec, if and when you build that.

## Run it
```bash
cd tools/reference-link-indexer
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt   # stdlib only at runtime; this just adds pytest for the tests
python reference_link_indexer.py --target 2000
pytest -q
```

To use your own query set instead of the built-in open-film/animation
collections:
```bash
python reference_link_indexer.py --target 2000 --query-file queries.txt
```

To bring in links from any OTHER catalog whose terms you've actually checked
(NASA, Wikimedia Commons, a licensed stock-footage export, etc.), export it to
JSONL yourself and import it — this script never guesses URLs for you:
```bash
python reference_link_indexer.py --import-jsonl my_authorized_catalog.jsonl
```

## Before using any of this for training
Every record has `ai_training_permission: "unknown — verify item-specific
rights"` by default. That's not a formality — go check. A public Archive.org
item page, a public YouTube link, or a GitHub research-dataset repo (like
AnimeShooter or Sakuga-42M, which you also referenced) is not, by itself,
permission to train commercially. See the per-item rights-tracking fields
suggested in the Training Studio spec you wrote (`source`, `license_url`,
`ai_training_permission`, `commercial_training_allowed`) and fill them in
before anything goes into an actual training run.
