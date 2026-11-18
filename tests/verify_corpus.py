#!/usr/bin/env python3
"""Integrity harness for Tawatur.

Re-derives every claim the app makes from the database itself, then (unless
--db-only) exercises the live HTTP API the browser talks to. Exit code is the
number of failures, so it can gate a rebuild.

    python3 tests/verify_corpus.py            # database + API
    python3 tests/verify_corpus.py --db-only  # database only
    python3 tests/verify_corpus.py --live     # also re-fetch the three sources
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import verifier  # noqa: E402

DB = ROOT / "data" / "bayan.db"
TANZIL_SHA256 = "ac0724796cbbda0f4801470fbbd11d0f3c5802067bae0493466d0128b0c667af"
BASE = "http://127.0.0.1:8150"

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("  ok   " if ok else "  FAIL ") + name + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def open_db() -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def db_checks() -> None:
    con = open_db()
    print("database")
    verses = con.execute("SELECT COUNT(*) n FROM verses").fetchone()["n"]
    surahs = con.execute("SELECT COUNT(*) n FROM surahs").fetchone()["n"]
    check("114 surahs", surahs == 114, str(surahs))
    check("6236 verses", verses == 6236, str(verses))

    meta = dict(con.execute("SELECT key, value FROM meta").fetchall())
    check("Tanzil checksum recorded", meta.get("tanzil_sha256") == TANZIL_SHA256)

    # every verse has exactly three source rows
    per_verse = con.execute(
        "SELECT COUNT(*) n FROM source_text GROUP BY verse_key"
    ).fetchall()
    check("three source rows per verse", len(per_verse) == 6236 and all(r["n"] == 3 for r in per_verse),
          f"{len(per_verse)} verses, min {min(r['n'] for r in per_verse)}")

    # per-surah counts match the published table and add up
    counts = {r["surah"]: r["n"] for r in con.execute("SELECT surah, COUNT(*) n FROM verses GROUP BY surah")}
    declared = {r["number"]: r["ayahs"] for r in con.execute("SELECT number, ayahs FROM surahs")}
    check("per-surah counts match metadata", all(counts[s] == declared[s] for s in counts) and len(counts) == 114)
    check("counts sum to 6236", sum(counts.values()) == 6236, str(sum(counts.values())))

    # no empty verse, no duplicate key
    empty = con.execute("SELECT COUNT(*) n FROM verses WHERE letters_count < 1 OR length(text_verse) = 0").fetchone()["n"]
    check("no empty verse", empty == 0, str(empty))
    dupes = con.execute("SELECT COUNT(*) n FROM (SELECT key FROM verses GROUP BY key HAVING COUNT(*) > 1)").fetchone()["n"]
    check("no duplicate verse keys", dupes == 0)

    # basmala bookkeeping
    basmala = con.execute("SELECT COUNT(*) n FROM verses WHERE basmala = 1").fetchone()["n"]
    check("112 surah openers carry a basmala flag", basmala == 112, str(basmala))
    first = con.execute("SELECT letters FROM verses WHERE key='1:1'").fetchone()["letters"]
    check("1:1 keeps the basmala as its own verse text", first == verifier.BASMALA_LETTERS)
    ninth = con.execute("SELECT text_full FROM verses WHERE key='9:1'").fetchone()["text_full"]
    check("9:1 has no basmala", not verifier.has_basmala(ninth))

    # the actual cross-check, recomputed from stored source texts
    print("cross-check (recomputed from stored source texts)")
    rows = con.execute(
        "SELECT v.key, v.letters, v.consensus, s.source, s.text, s.letters_equal "
        "FROM verses v JOIN source_text s ON s.verse_key = v.key ORDER BY v.surah, v.ayah"
    ).fetchall()
    agree = {r["key"] for r in rows if r["letters_equal"]}
    wrong_flag = [
        (r["key"], r["source"]) for r in rows
        if (verifier.letters(verifier.verse_core(r["text"])) == r["letters"]) != bool(r["letters_equal"])
    ]
    check("each source's match flag equals a fresh comparison", not wrong_flag, f"{len(wrong_flag)} wrong")

    # consensus = the canonical text (1) + each cross-check that matches its letters
    recomputed: dict[str, int] = {}
    for r in rows:
        recomputed.setdefault(r["key"], 0)
        if r["source"] == "tanzil" or r["letters_equal"]:
            recomputed[r["key"]] += 1
    stored = {r["key"]: r["consensus"] for r in con.execute("SELECT key, consensus FROM verses")}
    check("stored consensus equals recomputed consensus", recomputed == stored)

    three = sum(1 for v in stored.values() if v == 3)
    two = sorted(k for k, v in stored.items() if v == 2)
    check("6,234 verses agree 3/3", three == 6234, str(three))
    check("exactly 12:39 and 12:41 are 2/3", two == ["12:39", "12:41"], str(two))

    # translations
    tr = con.execute("SELECT lang, COUNT(*) n FROM translations GROUP BY lang").fetchall()
    check("two translation editions, 6236 each", all(r["n"] == 6236 for r in tr) and len(tr) == 2,
          str({r["lang"]: r["n"] for r in tr}))
    con.close()


def api_checks(live: bool) -> None:
    print("http api")
    try:
        status = get_json("/api/status")
    except Exception as exc:
        check("API reachable", False, str(exc))
        return
    check("API reachable", True)
    check("status reports ok", status["ok"] is True)
    check("status counts match", status["totals"]["verses"] == 6236 and status["totals"]["three_of_three"] == 6234)

    surah = get_json("/api/surah/2")
    check("surah 2 has 286 verses", len(surah["verses"]) == 286, str(len(surah["verses"])))
    check("surah 2 verse 1 is stripped of the basmala", not surah["verses"][0]["text"].startswith("بِسْمِ"))

    verse = get_json("/api/verse/2:255")
    check("2:255 loads with 3 sources", len(verse["sources"]) == 3)
    check("2:255 is 3/3", verse["verse"]["consensus"] == 3)
    check("2:255 carries English and Malay", {"en", "ms"} <= set(verse["verse"]["translations"]))

    variant = get_json("/api/verse/12:39")
    check("12:39 reports 2/3", variant["verse"]["consensus"] == 2)
    diff = [s for s in variant["sources"] if not s["letters_equal"]][0]
    check("12:39 diff points at a word present in the text",
          bool(diff["diff"]) and diff["diff"][0]["candidate"] in diff["text"],
          diff["diff"][0]["candidate"] if diff["diff"] else "no diff")

    bad = request("/api/verse/115:1")
    check("out-of-range reference is refused", bad[0] == 404, str(bad[0]))
    bad = request("/api/verse/abc")
    check("malformed reference is refused", bad[0] == 400, str(bad[0]))

    arabic = get_json("/api/search?q=%D8%A7%D9%84%D8%B1%D8%AD%D9%85%D9%86")
    check("arabic search returns verses", arabic["mode"] == "arabic" and len(arabic["results"]) > 0,
          f"{len(arabic['results'])} hits")
    latin = get_json("/api/search?q=mercy")
    check("latin search uses translations", latin["mode"] == "translation" and len(latin["results"]) > 0,
          f"{len(latin['results'])} hits")
    check("arabic search ignores diacritics", any(r["key"] == "1:3" for r in arabic["results"]))

    rand = get_json("/api/random")
    check("random returns a real verse", bool(get_json(f"/api/verse/{rand['key']}")["verse"]["text"]))

    resp = urllib.request.urlopen(BASE + "/")
    check("page sends Cache-Control: no-store", resp.headers.get("Cache-Control") == "no-store",
          str(resp.headers.get("Cache-Control")))

    audio_checks()

    if live:
        print("live re-check (network)")
        out = get_json("/api/verify/2:255", timeout=180)
        check("live check agrees 3/3", out["agreeing"] == 3 and out["responding"] == 3,
              f"{out['agreeing']}/{out['responding']}")
        tz = [s for s in out["sources"] if s["id"] == "tanzil"][0]
        check("live Tanzil checksum matches", tz.get("checksum_ok") is True)


def post(path: str, timeout: int = 30):
    req = urllib.request.Request(BASE + path, method="POST", headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read())


def audio_checks() -> None:
    print("recitation")
    cfg = get_json("/api/audio/config")
    check("reciters offered", len(cfg["editions"]) >= 3, f"{len(cfg['editions'])} editions")
    check("audio bitrate is 64 kbps", cfg["bitrate"] == 64)

    state = get_json("/api/audio/113?edition=ar.alafasy")
    check("one audio url per verse", len(state["urls"]) == 5, str(len(state["urls"])))

    if not state["complete"]:
        post("/api/audio/113/download?edition=ar.alafasy")
        for _ in range(40):
            time.sleep(1)
            polled = get_json("/api/audio/113/status?edition=ar.alafasy")
            if polled.get("state") in ("done", "error"):
                break
        state = get_json("/api/audio/113?edition=ar.alafasy")

    check("surah audio downloaded", state["complete"] and state["bytes"] > 0,
          f"{state['present']}/{state['ayahs']} files, {state['bytes']} bytes")
    check("downloaded files are served locally", state["urls"]["1"].startswith("/audio/"),
          state["urls"]["1"])

    with urllib.request.urlopen(BASE + state["urls"]["1"], timeout=20) as resp:
        body = resp.read()
        check("audio file plays back over http", resp.status == 200 and resp.headers.get("Content-Type") == "audio/mpeg" and len(body) > 5000,
              f"{len(body)} bytes, {resp.headers.get('Content-Type')}")
        check("audio is really MP3", body[:3] == b"ID3" or body[0] == 0xFF, str(body[:3]))

    req = urllib.request.Request(BASE + state["urls"]["1"], headers={"Range": "bytes=0-99"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        check("range requests work (seeking)", resp.status == 206, str(resp.status))

    bad = request("/api/audio/115?edition=ar.alafasy")
    check("bad surah number refused", bad[0] == 400, str(bad[0]))
    bad = request("/api/audio/1?edition=nope")
    check("unknown reciter refused", bad[0] == 400, str(bad[0]))


def request(path: str, timeout: int = 20):
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def get_json(path: str, timeout: int = 20):
    status, body = request(path, timeout)
    if status != 200:
        raise RuntimeError(f"{path} -> {status}")
    return json.loads(body)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db-only", action="store_true")
    ap.add_argument("--live", action="store_true")
    args = ap.parse_args()
    db_checks()
    if not args.db_only:
        api_checks(args.live)
    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return len(failures)
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
