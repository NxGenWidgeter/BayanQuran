#!/usr/bin/env python3
"""BayanQuran - a local Quran verse reader that proves every verse.

The server is read-only over data/bayan.db, binds to loopback only, and exposes
one endpoint that re-fetches the three published sources on demand so a reader can
check a verse themselves instead of trusting the build.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

import audio
import guides
import verifier

ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "bayan.db"
STATIC = ROOT / "static"
VERSION = (ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").exists() else "0.0.0"
TANZIL_SHA256 = "ac0724796cbbda0f4801470fbbd11d0f3c5802067bae0493466d0128b0c667af"
TANZIL_TXT_URL = "https://tanzil.net/pub/download/index.php?quranType=uthmani&outType=txt&agree=true"
QURAN_COM_AYAH = "https://api.quran.com/api/v4/verses/by_key/{key}?fields=text_uthmani"
ALQURAN_AYAH = "https://api.alquran.cloud/v1/ayah/{key}/quran-uthmani"
UA = "BayanQuran/1.0 (local Quran text verifier)"

if not DB.exists():
    raise SystemExit("data/bayan.db is missing - run ./build_corpus.py first")

app = FastAPI(title="BayanQuran", docs_url=None, redoc_url=None)

# ---------------------------------------------------------------- plumbing


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    return con


@app.middleware("http")
async def loopback_only(request: Request, call_next):
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1", "localhost"):
        return PlainTextResponse("BayanQuran only answers on loopback.", status_code=403)
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.url.path.startswith("/api/"):
        # A cached "3 of 3 agree" would be a lie the moment the corpus is rebuilt.
        response.headers["Cache-Control"] = "no-store"
    return response


def asset_version() -> str:
    newest = max((p.stat().st_mtime for p in STATIC.rglob("*") if p.is_file()), default=0)
    return hashlib.sha1(f"{newest}".encode()).hexdigest()[:10]


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    # The shell names the asset version; caching it pins an old app.js forever.
    return HTMLResponse(
        html.replace("__V__", asset_version()),
        headers={"Cache-Control": "no-store"},
    )


@app.get("/healthz", response_class=PlainTextResponse)
def healthz() -> str:
    return "ok"


app.mount("/static", StaticFiles(directory=STATIC), name="static")

# Recitation files are downloaded on demand; the mount has to exist up front.
audio.AUDIO.mkdir(parents=True, exist_ok=True)
app.mount("/audio", StaticFiles(directory=audio.AUDIO), name="audio")


# ---------------------------------------------------------------- data access

SURAH_FIELDS = "number, name_ar, name_ar_short, name_en, meaning, ayahs, revelation"


def surah_row(con: sqlite3.Connection, number: int) -> dict:
    row = con.execute(f"SELECT {SURAH_FIELDS} FROM surahs WHERE number=?", (number,)).fetchone()
    if not row:
        raise HTTPException(404, f"no surah {number}")
    return dict(row)


def parse_key(key: str) -> tuple[int, int]:
    m = re.fullmatch(r"\s*(\d{1,3})\s*[:.\s]\s*(\d{1,3})\s*", key)
    if not m:
        raise HTTPException(400, "verse reference must look like 2:255")
    return int(m.group(1)), int(m.group(2))


def translation_map(con: sqlite3.Connection, keys: list[str]) -> dict[str, dict[str, str]]:
    if not keys:
        return {}
    marks = ",".join("?" * len(keys))
    rows = con.execute(
        f"SELECT verse_key, lang, text FROM translations WHERE verse_key IN ({marks})", keys
    ).fetchall()
    out: dict[str, dict[str, str]] = {}
    for r in rows:
        out.setdefault(r["verse_key"], {})[r["lang"]] = r["text"]
    return out


@app.get("/api/surahs")
def api_surahs() -> JSONResponse:
    with connect() as con:
        rows = con.execute(f"SELECT {SURAH_FIELDS} FROM surahs ORDER BY number").fetchall()
    return JSONResponse([dict(r) for r in rows])


@app.get("/api/surah/{number}")
def api_surah(number: int) -> JSONResponse:
    with connect() as con:
        surah = surah_row(con, number)
        verses = con.execute(
            "SELECT key, ayah, text_verse, basmala, consensus, variants, letters_count "
            "FROM verses WHERE surah=? ORDER BY ayah",
            (number,),
        ).fetchall()
        tr = translation_map(con, [v["key"] for v in verses])
    payload = []
    for v in verses:
        payload.append(
            {
                "key": v["key"],
                "ayah": v["ayah"],
                "text": v["text_verse"],
                "basmala": bool(v["basmala"]),
                "consensus": v["consensus"],
                "variants": v["variants"].split(",") if v["variants"] else [],
                "letters": v["letters_count"],
                "translations": tr.get(v["key"], {}),
            }
        )
    return JSONResponse({"surah": surah, "verses": payload})


@app.get("/api/verse/{key}")
def api_verse(key: str) -> JSONResponse:
    surah_no, ayah_no = parse_key(key)
    vkey = f"{surah_no}:{ayah_no}"
    with connect() as con:
        verse = con.execute(
            "SELECT key, surah, ayah, text_full, text_verse, basmala, letters, letters_count, "
            "consensus, variants FROM verses WHERE key=?",
            (vkey,),
        ).fetchone()
        if not verse:
            raise HTTPException(404, f"{vkey} is not a verse in the corpus")
        surah = surah_row(con, surah_no)
        sources = con.execute(
            "SELECT source_text.source, source_text.text, source_text.exact, "
            "source_text.letters_equal, sources.name, sources.edition, sources.url, sources.role "
            "FROM source_text JOIN sources ON sources.id = source_text.source "
            "WHERE verse_key=? ORDER BY CASE sources.role WHEN 'canonical' THEN 0 ELSE 1 END, sources.name",
            (vkey,),
        ).fetchall()
        tr = translation_map(con, [vkey]).get(vkey, {})
        prev_row = con.execute(
            "SELECT key FROM verses WHERE (surah < ?) OR (surah = ? AND ayah < ?) "
            "ORDER BY surah DESC, ayah DESC LIMIT 1",
            (surah_no, surah_no, ayah_no),
        ).fetchone()
        next_row = con.execute(
            "SELECT key FROM verses WHERE (surah > ?) OR (surah = ? AND ayah > ?) "
            "ORDER BY surah ASC, ayah ASC LIMIT 1",
            (surah_no, surah_no, ayah_no),
        ).fetchone()

    variants = verse["variants"].split(",") if verse["variants"] else []
    source_payload = []
    for s in sources:
        # Recompute the token diff on the fly so the UI can highlight the exact word.
        diff = [] if s["letters_equal"] else verifier.compare(verse["text_full"], s["text"])["diff_tokens"]
        source_payload.append(
            {
                "id": s["source"],
                "name": s["name"],
                "edition": s["edition"],
                "url": s["url"],
                "role": s["role"],
                "text": s["text"],
                "exact": bool(s["exact"]),
                "letters_equal": bool(s["letters_equal"]),
                "diff": diff,
            }
        )
    return JSONResponse(
        {
            "verse": {
                "key": verse["key"],
                "surah": verse["surah"],
                "ayah": verse["ayah"],
                "text_full": verse["text_full"],
                "text": verse["text_verse"],
                "basmala": bool(verse["basmala"]),
                "letters": verse["letters_count"],
                "consensus": verse["consensus"],
                "variants": variants,
                "translations": tr,
            },
            "surah": surah,
            "sources": source_payload,
            "prev": prev_row["key"] if prev_row else None,
            "next": next_row["key"] if next_row else None,
        }
    )


@app.get("/api/search")
def api_search(q: str = "", limit: int = 40) -> JSONResponse:
    q = q.strip()
    if len(q) < 2:
        return JSONResponse({"query": q, "results": [], "mode": None})
    limit = max(1, min(limit, 100))
    arabic_q = verifier.letters(q)
    looks_arabic = bool(re.search(r"[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]", q))
    with connect() as con:
        if looks_arabic and len(arabic_q) >= 2:
            rows = con.execute(
                "SELECT v.key, v.surah, v.ayah, v.text_verse, v.consensus, s.name_en, "
                "s.name_ar_short FROM verses v JOIN surahs s ON s.number=v.surah "
                "WHERE v.search LIKE ? ORDER BY v.ordinal LIMIT ?",
                (f"%{arabic_q}%", limit),
            ).fetchall()
            mode = "arabic"
        else:
            rows = con.execute(
                "SELECT v.key, v.surah, v.ayah, v.text_verse, v.consensus, s.name_en, "
                "s.name_ar_short FROM verses v JOIN surahs s ON s.number=v.surah "
                "WHERE v.key IN (SELECT verse_key FROM translations WHERE lower(text) LIKE ?) "
                "ORDER BY v.ordinal LIMIT ?",
                (f"%{q.lower()}%", limit),
            ).fetchall()
            mode = "translation"
        keys = [r["key"] for r in rows]
        tr = translation_map(con, keys)
    results = []
    for r in rows:
        t = tr.get(r["key"], {})
        snippet = t.get("en") or ""
        if mode == "translation":
            idx = max(snippet.lower().find(q.lower()), 0)
            snippet = snippet[max(0, idx - 60): idx + 160].strip()
        results.append(
            {
                "key": r["key"],
                "surah": r["surah"],
                "ayah": r["ayah"],
                "name_en": r["name_en"],
                "name_ar": r["name_ar_short"],
                "text": r["text_verse"],
                "consensus": r["consensus"],
                "translation": snippet,
            }
        )
    return JSONResponse({"query": q, "results": results, "mode": mode})


@app.get("/api/random")
def api_random() -> JSONResponse:
    with connect() as con:
        row = con.execute("SELECT key FROM verses ORDER BY RANDOM() LIMIT 1").fetchone()
    return JSONResponse({"key": row["key"]})


@app.get("/api/verify/{key}")
def api_verify(key: str) -> JSONResponse:
    """Re-fetch all three sources right now and compare against the stored verse.

    The three downloads run concurrently: Tanzil ships the whole text file (that
    is what makes the checksum meaningful), the two APIs answer one verse at a
    time. A source that cannot be reached is reported as an error, never as
    agreement.
    """
    surah_no, ayah_no = parse_key(key)
    vkey = f"{surah_no}:{ayah_no}"
    with connect() as con:
        verse = con.execute(
            "SELECT text_full, letters, ordinal FROM verses WHERE key=?", (vkey,)
        ).fetchone()
        if not verse:
            raise HTTPException(404, f"{vkey} is not a verse in the corpus")
    expected = verse["letters"]
    ordinal = verse["ordinal"]
    started = time.time()

    def get(url: str, timeout: int = 25) -> bytes:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()

    def measured(fn, source_id: str, name: str, note: str, timeout: int):
        t0 = time.time()
        try:
            text, extra = fn()
            same = verifier.letters(verifier.verse_core(text)) == expected
            out = {
                "id": source_id,
                "name": name,
                "ok": same,
                "letters_equal": same,
                "text": text,
                "ms": int((time.time() - t0) * 1000),
                "note": note,
            }
            out.update(extra or {})
            return out
        except Exception as exc:
            return {
                "id": source_id,
                "name": name,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "ms": int((time.time() - t0) * 1000),
            }

    def tanzil_fn():
        body = get(TANZIL_TXT_URL, timeout=45)
        digest = hashlib.sha256(body).hexdigest()
        lines = [
            ln for ln in body.decode("utf-8").splitlines()
            if ln.strip() and not ln.startswith("#")
        ]
        if len(lines) != 6236:
            raise ValueError(f"expected 6236 verse lines, got {len(lines)}")
        return lines[ordinal], {"checksum_ok": digest == TANZIL_SHA256, "sha256": digest}

    def quran_com_fn():
        payload = json.loads(get(QURAN_COM_AYAH.format(key=vkey), timeout=25))
        return payload["verse"]["text_uthmani"].strip(), {}

    def alquran_fn():
        payload = json.loads(get(ALQURAN_AYAH.format(key=vkey), timeout=25))
        return payload["data"]["text"].strip(), {}

    jobs = [
        (tanzil_fn, "tanzil", "Tanzil Project", "whole file re-downloaded and hashed", 45),
        (quran_com_fn, "quran_com", "Quran.com", "single verse", 25),
        (alquran_fn, "alquran_cloud", "Al Quran Cloud", "single verse", 25),
    ]
    results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {
            pool.submit(measured, fn, sid, name, note, timeout): sid
            for fn, sid, name, note, timeout in jobs
        }
        for future in as_completed(futures):
            results[futures[future]] = future.result()

    ordered = [results[sid] for _, sid, _, _, _ in jobs]
    responding = [r for r in ordered if not r.get("error")]
    agreeing = [r for r in responding if r.get("letters_equal")]
    return JSONResponse(
        {
            "key": vkey,
            "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "seconds": round(time.time() - started, 2),
            "agreeing": len(agreeing),
            "responding": len(responding),
            "total": len(ordered),
            "sources": ordered,
        }
    )


# ---------------------------------------------------------------- recitation


def _surah_arg(surah: int) -> None:
    if not 1 <= surah <= 114:
        raise HTTPException(400, "surah must be 1-114")


def _edition_arg(edition: str | None) -> str:
    edition = edition or audio.DEFAULT_EDITION
    if edition not in audio.EDITIONS:
        raise HTTPException(400, f"unknown reciter {edition!r}")
    return edition


@app.get("/api/audio/config")
def api_audio_config() -> JSONResponse:
    return JSONResponse(
        {
            "default": audio.DEFAULT_EDITION,
            "bitrate": audio.DEFAULT_BITRATE,
            "bytes_per_ayah": audio.BYTES_PER_AYAH,
            "editions": [audio.edition_info(e) for e in audio.EDITIONS],
            "downloaded": {e: audio.downloaded_surahs(e) for e in audio.EDITIONS},
        }
    )


@app.get("/api/audio/{surah}")
def api_audio_surah(surah: int, edition: str | None = None) -> JSONResponse:
    _surah_arg(surah)
    edition = _edition_arg(edition)
    state = audio.local_state(edition, surah)
    return JSONResponse(
        {
            **state,
            "urls": audio.urls_for(edition, surah),
            "job": audio.job_state(edition, surah),
        }
    )


@app.post("/api/audio/{surah}/download")
def api_audio_download(surah: int, edition: str | None = None) -> JSONResponse:
    _surah_arg(surah)
    edition = _edition_arg(edition)
    job = audio.start_download(edition, surah)
    return JSONResponse(job, status_code=202)


@app.get("/api/audio/{surah}/status")
def api_audio_status(surah: int, edition: str | None = None) -> JSONResponse:
    _surah_arg(surah)
    edition = _edition_arg(edition)
    job = audio.job_state(edition, surah) or {"state": "idle"}
    return JSONResponse({**job, **audio.local_state(edition, surah)})


@app.delete("/api/audio/{surah}")
def api_audio_delete(surah: int, edition: str | None = None) -> JSONResponse:
    _surah_arg(surah)
    edition = _edition_arg(edition)
    return JSONResponse(audio.delete_surah(edition, surah))


@app.get("/api/status")
def api_status() -> JSONResponse:
    with connect() as con:
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
            "SELECT lang, edition, translator, COUNT(*) AS n FROM translations GROUP BY lang, edition, translator ORDER BY lang"
        ).fetchall()

    declared_map = {r["number"]: r["ayahs"] for r in declared}
    count_ok = all(declared_map.get(r["surah"]) == r["n"] for r in counts) and len(counts) == 114
    checks = [
        {"name": "114 surahs", "ok": surah_total == 114, "detail": f"{surah_total} found"},
        {"name": "6,236 verses", "ok": totals["verses"] == 6236, "detail": f"{totals['verses']} stored"},
        {"name": "ayah counts match the published table", "ok": count_ok, "detail": "per-surah counts agree with Al Quran Cloud metadata"},
        {"name": "three source texts per verse", "ok": src_rows == 6236 * 3, "detail": f"{src_rows} source rows ({src_rows // 3} verses x 3)"},
        {"name": "no empty verse", "ok": empty == 0, "detail": f"{empty} empty"},
        {"name": "basmala placement", "ok": basmala == 112, "detail": f"{basmala} surah openers carry one (1:1 counted as its own verse)"},
        {"name": "translations aligned", "ok": translation_rows == 6236 * 2, "detail": f"{translation_rows} rows for 2 editions"},
        {"name": "Tanzil checksum recorded", "ok": meta.get("tanzil_sha256") == TANZIL_SHA256, "detail": TANZIL_SHA256[:16] + "..."},
    ]
    return JSONResponse(
        {
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
    )


@app.get("/api/guides")
def api_guides() -> JSONResponse:
    """The talks and the solat tutorials, or what is left of them.

    Curated files, not scraped: the catalogue records what YouTube reported when
    the videos were picked, and every tutorial sentence names the page it rests
    on. A missing or broken file is not a 500 — the loader is called non-strict,
    so the panel still opens, the payload says ``ok: false`` with every reason,
    and the header button hides itself. The strict validator stays the default
    for the CLI and the tests.
    """
    payload = guides.load(strict=False)
    if payload["problems"]:
        logging.getLogger("uvicorn.error").warning(
            "guides incomplete: %s", " | ".join(payload["problems"][:5])
        )
    return JSONResponse(payload)


@app.get("/api/health")
def api_health() -> dict:
    """Liveness for supervisors and scripts; /healthz stays the plain-text one."""
    return {
        "ok": True,
        "service": "bayanquran",
        "version": VERSION,
        "surahs": 114,
    }
