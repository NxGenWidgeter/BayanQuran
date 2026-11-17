#!/usr/bin/env python3
"""Export Bayan as a static site: no server, no install, just files.

The local app answers nine JSON endpoints by querying SQLite on every request.
None of that data changes between builds, so the whole API can be written out
once and served from any static host (GitHub Pages, Cloudflare Pages, a USB
stick). What cannot survive the trip is anything that needs a process:

  * live re-verification of the Tanzil file (tanzil.net sends no CORS header, so
    a browser cannot re-download and hash it) — the build-time checksum is
    exported and the two CORS-friendly APIs are checked in the browser instead;
  * per-surah audio downloads to a server disk — the browser caches the files
    itself (site.js), and streaming comes straight from the CDN.

Everything else is byte-identical: same verse texts, same diffs, same search.

  ./export_static.py [--out dist-site] [--site-url https://example.org/]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import audio
import verifier

ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "bayan.db"
STATIC = ROOT / "static"
VERSION = (ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").exists() else "0.0.0"
TANZIL_SHA256 = "ac0724796cbbda0f4801470fbbd11d0f3c5802067bae0493466d0128b0c667af"

SURAH_FIELDS = "number, name_ar, name_ar_short, name_en, meaning, ayahs, revelation"


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def dump(path: Path, payload: object) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    path.write_text(body, encoding="utf-8")
    return len(body.encode())


# ---------------------------------------------------------------- payloads


def surah_payload(con: sqlite3.Connection, number: int) -> dict:
    surah = dict(con.execute(f"SELECT {SURAH_FIELDS} FROM surahs WHERE number=?", (number,)).fetchone())
    rows = con.execute(
        "SELECT key, ayah, text_full, text_verse, basmala, consensus, variants, "
        "letters_count, ordinal FROM verses WHERE surah=? ORDER BY ayah",
        (number,),
    ).fetchall()
    keys = [r["key"] for r in rows]
    marks = ",".join("?" * len(keys))
    tr: dict[str, dict[str, str]] = {}
    for t in con.execute(
        f"SELECT verse_key, lang, text FROM translations WHERE verse_key IN ({marks})", keys
    ):
        tr.setdefault(t["verse_key"], {})[t["lang"]] = t["text"]
    sources: dict[str, list] = {}
    for s in con.execute(
        "SELECT st.verse_key, st.source, st.text, st.exact, st.letters_equal, "
        "s.name, s.edition, s.url, s.role FROM source_text st "
        "JOIN sources s ON s.id = st.source WHERE st.verse_key IN (" + marks + ") "
        "ORDER BY CASE s.role WHEN 'canonical' THEN 0 ELSE 1 END, s.name",
        keys,
    ):
        sources.setdefault(s["verse_key"], []).append(s)

    verses = []
    for i, r in enumerate(rows):
        src_out = []
        for s in sources.get(r["key"], []):
            equal = bool(s["letters_equal"])
            diff = [] if equal else verifier.compare(r["text_full"], s["text"])["diff_tokens"]
            src_out.append(
                {
                    "id": s["source"],
                    "name": s["name"],
                    "edition": s["edition"],
                    "url": s["url"],
                    "role": s["role"],
                    "text": s["text"],
                    "exact": bool(s["exact"]),
                    "letters_equal": equal,
                    "diff": diff,
                }
            )
        verses.append(
            {
                "key": r["key"],
                "ayah": r["ayah"],
                "n": r["ordinal"] + 1,  # global ayah number, what the CDN names files
                "text": r["text_verse"],
                "text_full": r["text_full"],
                "basmala": bool(r["basmala"]),
                "consensus": r["consensus"],
                "variants": r["variants"].split(",") if r["variants"] else [],
                "letters": r["letters_count"],
                "translations": tr.get(r["key"], {}),
                "sources": src_out,
                "prev": keys[i - 1] if i > 0 else None,
                "next": keys[i + 1] if i + 1 < len(keys) else None,
            }
        )
    # prev/next only reach outside the surah at its edges, which is what the
    # inspector's arrows want: they walk the whole corpus, not just this surah.
    if verses:
        before = con.execute(
            "SELECT key FROM verses WHERE (surah < ?) OR (surah = ? AND ayah < ?) "
            "ORDER BY surah DESC, ayah DESC LIMIT 1",
            (number, number, verses[0]["ayah"]),
        ).fetchone()
        after = con.execute(
            "SELECT key FROM verses WHERE (surah > ?) OR (surah = ? AND ayah > ?) "
            "ORDER BY surah ASC, ayah ASC LIMIT 1",
            (number, number, verses[-1]["ayah"]),
        ).fetchone()
        verses[0]["prev"] = before["key"] if before else None
        verses[-1]["next"] = after["key"] if after else None
    return {"surah": surah, "verses": verses}


def status_payload(con: sqlite3.Connection) -> dict:
    """The same integrity report app.py builds, computed once at publish time."""
    meta = dict(con.execute("SELECT key, value FROM meta").fetchall())
    report = json.loads(meta.get("report", "{}"))
    sources = [dict(r) for r in con.execute("SELECT * FROM sources").fetchall()]
    counts = con.execute(
        "SELECT surah, COUNT(*) AS n FROM verses GROUP BY surah ORDER BY surah"
    ).fetchall()
    declared = con.execute("SELECT number, ayahs FROM surahs ORDER BY number").fetchall()
    totals = con.execute(
        "SELECT COUNT(*) AS verses, SUM(consensus=3) AS three, SUM(consensus=2) AS two, "
        "SUM(consensus<2) AS low FROM verses"
    ).fetchone()
    src_rows = con.execute("SELECT COUNT(*) AS n FROM source_text").fetchone()["n"]
    empty = con.execute("SELECT COUNT(*) AS n FROM verses WHERE letters_count < 1").fetchone()["n"]
    basmala = con.execute("SELECT COUNT(*) AS n FROM verses WHERE basmala=1").fetchone()["n"]
    translation_rows = con.execute("SELECT COUNT(*) AS n FROM translations").fetchone()["n"]
    surah_total = con.execute("SELECT COUNT(*) AS n FROM surahs").fetchone()["n"]
    editions = con.execute(
        "SELECT lang, edition, translator, COUNT(*) AS n FROM translations "
        "GROUP BY lang, edition, translator ORDER BY lang"
    ).fetchall()

    declared_map = {r["number"]: r["ayahs"] for r in declared}
    count_ok = all(declared_map.get(r["surah"]) == r["n"] for r in counts) and len(counts) == 114
    checks = [
        {"name": "114 surahs", "ok": surah_total == 114, "detail": f"{surah_total} found"},
        {"name": "6,236 verses", "ok": totals["verses"] == 6236, "detail": f"{totals['verses']} stored"},
        {"name": "ayah counts match the published table", "ok": count_ok,
         "detail": "per-surah counts agree with Al Quran Cloud metadata"},
        {"name": "three source texts per verse", "ok": src_rows == 6236 * 3,
         "detail": f"{src_rows} source rows ({src_rows // 3} verses x 3)"},
        {"name": "no empty verse", "ok": empty == 0, "detail": f"{empty} empty"},
        {"name": "basmala placement", "ok": basmala == 112,
         "detail": f"{basmala} surah openers carry one (1:1 counted as its own verse)"},
        {"name": "translations aligned", "ok": translation_rows == 6236 * 2,
         "detail": f"{translation_rows} rows for 2 editions"},
        {"name": "Tanzil checksum recorded", "ok": meta.get("tanzil_sha256") == TANZIL_SHA256,
         "detail": TANZIL_SHA256[:16] + "..."},
    ]
    return {
        "static": True,
        "version": VERSION,
        "published_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "built_at": meta.get("built_at"),
        "corpus_sha256": meta.get("corpus_sha256"),
        "tanzil_sha256": meta.get("tanzil_sha256"),
        "sources": sources,
        "totals": {
            "surahs": len(counts),
            "verses": totals["verses"],
            "three_of_three": totals["three"],
            "two_of_three": totals["two"],
            "below_two": totals["low"],
        },
        "variants": report.get("variants", {}),
        "translations": [dict(r) for r in editions],
        "checks": checks,
        "ok": all(c["ok"] for c in checks),
    }


def search_index(con: sqlite3.Connection) -> dict:
    """One compact row per verse; the browser builds the letter index at load.

    Order is the corpus order, which is the order the server returns, so result
    lists come out identical.
    """
    rows = con.execute(
        "SELECT v.key, v.consensus, v.text_verse, v.basmala, "
        "MAX(CASE WHEN t.lang='en' THEN t.text END) AS en, "
        "MAX(CASE WHEN t.lang='ms' THEN t.text END) AS ms "
        "FROM verses v JOIN translations t ON t.verse_key=v.key "
        "GROUP BY v.key ORDER BY v.ordinal"
    ).fetchall()
    # Consensus, the verse, both translations, and whether the line carries a
    # basmala — the browser prepends those letters when it builds the Arabic
    # index, because the server's `search` column indexes the full line.
    return {"verses": [[r["key"], r["consensus"], r["text_verse"], r["en"] or "", r["ms"] or "", bool(r["basmala"])] for r in rows]}


def audio_payload() -> dict:
    return {
        "static": True,
        "default": audio.DEFAULT_EDITION,
        "bitrate": audio.DEFAULT_BITRATE,
        "bytes_per_ayah": audio.BYTES_PER_AYAH,
        "editions": [audio.edition_info(e) for e in audio.EDITIONS],
        "cdn": audio.CDN,
    }


def write_index(out: Path, build: str, site_url: str) -> None:
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    html = html.replace('"/static/', '"static/').replace("__V__", build)
    html = html.replace(
        '<script src="static/app.js',
        '<script src="static/site.js?v=' + build + '"></script>\n  <script src="static/app.js',
    )
    html = html.replace(
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<meta name="theme-color" content="#0e1116">\n'
        '<link rel="manifest" href="manifest.webmanifest">\n'
        '<link rel="icon" href="static/icon.svg" type="image/svg+xml">',
    )
    if site_url:
        html = html.replace(
            "</head>", f'<link rel="canonical" href="{site_url}">\n</head>'
        )
    (out / "index.html").write_text(html, encoding="utf-8")


def write_manifest(out: Path) -> None:
    (out / "manifest.webmanifest").write_text(
        json.dumps(
            {
                "name": "Bayan — Quran verses, checked at the letter",
                "short_name": "Bayan",
                "start_url": "./",
                "scope": "./",
                "display": "standalone",
                "background_color": "#0e1116",
                "theme_color": "#0e1116",
                "icons": [
                    {"src": "static/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"}
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="dist-site")
    ap.add_argument("--site-url", default="", help="canonical URL, written into index.html")
    ap.add_argument("--keep", action="store_true", help="keep an existing output directory")
    args = ap.parse_args()

    out = (ROOT / args.out).resolve()
    if out.exists() and not args.keep:
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    con = connect()
    surahs = [dict(r) for r in con.execute(f"SELECT {SURAH_FIELDS} FROM surahs ORDER BY number")]
    status = status_payload(con)

    sizes: dict[str, int] = {}
    sizes["data/surahs.json"] = dump(out / "data/surahs.json", surahs)
    sizes["data/status.json"] = dump(out / "data/status.json", status)
    sizes["data/audio.json"] = dump(out / "data/audio.json", audio_payload())

    total_verses = 0
    for s in surahs:
        payload = surah_payload(con, s["number"])
        total_verses += len(payload["verses"])
        sizes[f"data/surah/{s['number']:03d}.json"] = dump(
            out / "data" / "surah" / f"{s['number']:03d}.json", payload
        )
    sizes["data/search.json"] = dump(out / "data/search.json", search_index(con))
    con.close()

    (out / "static").mkdir(parents=True, exist_ok=True)
    for name in ("index.html", "style.css", "app.js", "site.js", "icon.svg"):
        shutil.copy2(STATIC / name, out / "static" / name)
    shutil.copytree(STATIC / "fonts", out / "static" / "fonts", dirs_exist_ok=True)

    build = hashlib.sha1(
        f"{VERSION}:{status['built_at']}:{sizes['data/search.json']}".encode()
    ).hexdigest()[:10]
    write_index(out, build, args.site_url)
    write_manifest(out)
    (out / ".nojekyll").write_text("", encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nAllow: /\n", encoding="utf-8")
    (out / "404.html").write_text(
        '<!DOCTYPE html><meta charset="utf-8"><title>Bayan</title>'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<body style="background:#0e1116;color:#e8e6e3;font:16px system-ui;'
        'display:grid;place-items:center;height:100vh;margin:0;text-align:center">'
        '<div><p>That page is not part of the corpus.</p>'
        '<p><a style="color:#c9a227" href="./">Open Bayan</a></p></div>',
        encoding="utf-8",
    )

    print(f"bayan {VERSION} → {out.relative_to(ROOT)}/")
    print(f"  {total_verses} verses, {len(surahs)} surahs, build {build}")
    top = sorted(sizes.items(), key=lambda kv: -kv[1])[:6]
    for name, n in top:
        print(f"  {n/1024:8.1f} KB  {name}")
    print(f"  {sum(sizes.values())/1048576:8.1f} MB  data/ total")
    return 0 if total_verses == 6236 and status["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
