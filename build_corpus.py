#!/usr/bin/env python3
"""Build Tawatur's verified corpus.

Downloads the Uthmani text from three separately published digitizations, proves
the Tanzil file against its published SHA-256, checks the whole corpus structure,
compares every verse letter-for-letter across the three sources, and writes the
result to data/bayan.db with a build report.

    ./build_corpus.py            # use cache, fetch what is missing
    ./build_corpus.py --refresh  # re-download everything
    ./build_corpus.py --offline  # never touch the network (needs a full cache)

Exit code is non-zero if any integrity assertion fails; a corpus that does not
pass is never written.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import verifier

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RAW = DATA / "raw"
DB = DATA / "bayan.db"

UA = "Tawatur/1.0 (local Quran text verifier; +https://tanzil.net)"

TANZIL_TXT = "https://tanzil.net/pub/download/index.php?quranType=uthmani&outType=txt&agree=true"
TANZIL_KEYED = "https://tanzil.net/pub/download/index.php?quranType=uthmani&outType=txt-2&agree=true"
TANZIL_SHA256 = "ac0724796cbbda0f4801470fbbd11d0f3c5802067bae0493466d0128b0c667af"
TANZIL_BYTES = 1_334_737
QURAN_COM = "https://api.quran.com/api/v4/quran/verses/uthmani?chapter_number={ch}"
ALQURAN_CLOUD = "https://api.alquran.cloud/v1/quran/quran-uthmani"
AC_META = "https://api.alquran.cloud/v1/meta"
AC_TRANSLATION = "https://api.alquran.cloud/v1/quran/{edition}"

TRANSLATIONS = [
    ("en", "en.sahih", "Saheeh International"),
    ("ms", "ms.basmeih", "Basmeih (Tafsir Pimpinan ar-Rahman)"),
]

SOURCES = [
    {
        "id": "tanzil",
        "name": "Tanzil Project",
        "edition": "Uthmani 1.1",
        "url": "https://tanzil.net/download/",
        "license": "https://tanzil.net/docs/Text_License",
        "role": "canonical",
    },
    {
        "id": "quran_com",
        "name": "Quran.com (Quran Foundation API)",
        "edition": "Uthmani",
        "url": "https://api.quran.com/api/v4/quran/verses/uthmani",
        "license": "https://quran.com",
        "role": "cross-check",
    },
    {
        "id": "alquran_cloud",
        "name": "Al Quran Cloud",
        "edition": "quran-uthmani",
        "url": "https://api.alquran.cloud/v1/quran/quran-uthmani",
        "license": "https://alquran.cloud",
        "role": "cross-check",
    },
]


class FetchError(RuntimeError):
    pass


def fetch(url: str, cache: Path, refresh: bool, offline: bool, tries: int = 4) -> bytes:
    """Fetch with an on-disk cache, so a build can be reproduced offline."""
    if cache.exists() and not refresh:
        return cache.read_bytes()
    if offline:
        raise FetchError(f"offline and no cached copy: {cache}")

    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as resp:
                body = resp.read()
            if not body:
                raise FetchError(f"empty response from {url}")
            cache.parent.mkdir(parents=True, exist_ok=True)
            tmp = cache.with_suffix(cache.suffix + ".part")
            tmp.write_bytes(body)
            os.replace(tmp, cache)
            return body
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise FetchError(f"failed after {tries} tries: {url}: {last}")


def parse_tanzil(text: str) -> tuple[dict[str, str], int]:
    verses: dict[str, str] = {}
    for line in text.splitlines():
        line = line.rstrip("\n")
        if not line.strip() or line.startswith("#"):
            continue
        surah, ayah, body = line.split("|", 2)
        verses[f"{int(surah)}:{int(ayah)}"] = body
    return verses, len(verses)


# Quran.com metadata says "Meccan"/"Medinan"; the app says Mekah/Madinah.
REVELATION_LABELS = {"Meccan": "Mekah", "Medinan": "Madinah"}


def revelation_label(value: str) -> str:
    return REVELATION_LABELS.get(value, value)


def key_order(key: str) -> tuple[int, int]:
    s, a = key.split(":")
    return int(s), int(a)


def fetch_quran_com(offline: bool, refresh: bool) -> dict[str, str]:
    verses: dict[str, str] = {}
    for ch in range(1, 115):
        body = fetch(QURAN_COM.format(ch=ch), RAW / "quran_com" / f"{ch:03d}.json", refresh, offline)
        payload = json.loads(body)
        for verse in payload.get("verses", []):
            verses[verse["verse_key"]] = verse["text_uthmani"].strip()
    return verses


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-download every source")
    ap.add_argument("--offline", action="store_true", help="use cached downloads only")
    args = ap.parse_args()

    DATA.mkdir(parents=True, exist_ok=True)
    problems: list[str] = []

    def check(ok: bool, message: str) -> None:
        print(("  ok   " if ok else "  FAIL ") + message)
        if not ok:
            problems.append(message)

    print("1. Tanzil (Uthmani 1.1) - checksum and key alignment")
    plain = fetch(TANZIL_TXT, RAW / "tanzil-uthmani-txt.txt", args.refresh, args.offline)
    keyed = fetch(TANZIL_KEYED, RAW / "tanzil-uthmani-keyed.txt", args.refresh, args.offline)
    digest = hashlib.sha256(plain).hexdigest()
    check(digest == TANZIL_SHA256, f"SHA-256 {digest} matches the published Tanzil 1.1 checksum")
    check(len(plain) == TANZIL_BYTES, f"byte count {len(plain)} equals the published {TANZIL_BYTES}")
    keyed_sha = hashlib.sha256(keyed).hexdigest()

    tanzil, tz_count = parse_tanzil(keyed.decode("utf-8"))
    plain_lines = [ln for ln in plain.decode("utf-8").splitlines() if ln.strip() and not ln.startswith("#")]
    check(tz_count == 6236, f"keyed file holds {tz_count} verses")
    check(len(plain_lines) == tz_count, f"plain file holds {len(plain_lines)} verse lines")
    ordered = sorted(tanzil, key=key_order)
    mismatched_lines = [
        k for k, line in zip(ordered, plain_lines) if tanzil[k] != line
    ]
    check(not mismatched_lines, "the checksum-verified download and the keyed file agree line by line")

    print("\n2. Quran.com (Quran Foundation)")
    qc = fetch_quran_com(args.offline, args.refresh)
    check(len(qc) == 6236, f"{len(qc)} verses")
    check(set(qc) == set(ordered), "verse keys identical to Tanzil")

    print("\n3. Al Quran Cloud")
    ac_payload = json.loads(fetch(ALQURAN_CLOUD, RAW / "alquran-cloud-uthmani.json", args.refresh, args.offline))
    ac: dict[str, str] = {}
    for surah in ac_payload["data"]["surahs"]:
        for ayah in surah["ayahs"]:
            ac[f'{surah["number"]}:{ayah["numberInSurah"]}'] = ayah["text"].strip()
    check(len(ac) == 6236, f"{len(ac)} verses")
    check(set(ac) == set(ordered), "verse keys identical to Tanzil")

    print("\n4. Structure: 114 surahs, 6236 verses, per-surah counts")
    meta = json.loads(fetch(AC_META, RAW / "alquran-cloud-meta.json", args.refresh, args.offline))["data"]
    meta_surahs = {s["number"]: s for s in meta["surahs"]["references"]}
    check(len(meta_surahs) == 114, f"metadata describes {len(meta_surahs)} surahs")
    counts = {}
    for key in ordered:
        s, a = key_order(key)
        counts[s] = counts.get(s, 0) + 1
    check(sorted(counts) == list(range(1, 115)), "every surah number 1-114 appears")
    check(sum(counts.values()) == 6236, f"verse total is {sum(counts.values())}")
    check(all(meta_surahs[s]["numberOfAyahs"] == counts[s] for s in counts),
          "published ayah counts match the text for all 114 surahs")
    contiguous = all(
        counts[s] == max(key_order(k)[1] for k in ordered if key_order(k)[0] == s) for s in counts
    )
    check(contiguous, "ayah numbering within each surah has no gaps")

    print("\n5. Basmala placement")
    prefixed = [k for k in ordered if verifier.has_basmala(tanzil[k])]
    check(len(prefixed) == 113, f"{len(prefixed)} verses carry a basmala (1:1 plus 112 surah openers)")
    check(all(key_order(k)[1] == 1 for k in prefixed), "every basmala sits on verse 1")
    check("9:1" not in prefixed, "Surah At-Tawbah opens without a basmala")
    check(not any(verifier.has_basmala(qc[k]) for k in ordered if k != "1:1"), "Quran.com carries the basmala separately (only 1:1 is one)")

    print("\n6. Translations")
    translations: dict[tuple[str, str], dict[str, str]] = {}
    for lang, edition, _label in TRANSLATIONS:
        payload = json.loads(fetch(AC_TRANSLATION.format(edition=edition), RAW / f"translation-{edition}.json", args.refresh, args.offline))
        rows = {}
        for surah in payload["data"]["surahs"]:
            for ayah in surah["ayahs"]:
                rows[f'{surah["number"]}:{ayah["numberInSurah"]}'] = ayah["text"]
        check(len(rows) == 6236 and set(rows) == set(ordered), f"{edition}: 6236 verses, keys aligned")
        translations[(lang, edition)] = rows

    print("\n7. Letter-for-letter cross-check of all 6236 verses")
    consensus: dict[str, int] = {}
    variants: dict[str, list[str]] = {}
    details: dict[str, dict[str, dict]] = {}
    for key in ordered:
        canonical = tanzil[key]
        hits = 1
        row = {}
        for sid, other in (("quran_com", qc[key]), ("alquran_cloud", ac[key])):
            verdict = verifier.compare(canonical, other)
            row[sid] = verdict
            hits += 1 if verdict["letters_equal"] else 0
        consensus[key] = hits
        details[key] = row
        if hits < 3:
            variants[key] = [sid for sid, v in row.items() if not v["letters_equal"]]

    dist: dict[int, int] = {}
    for v in consensus.values():
        dist[v] = dist.get(v, 0) + 1
    print(f"   3/3 agreement: {dist.get(3, 0)}   2/3: {dist.get(2, 0)}   1/3: {dist.get(1, 0)}")
    for key, sids in variants.items():
        print(f"   variant {key}: disagrees with {', '.join(sids)}")
        for sid in sids:
            for d in details[key][sid]["diff_tokens"]:
                print(f"      {sid}: canonical {d['canonical']!r} vs {d['candidate']!r}")
    check(dist.get(1, 0) == 0, "no verse is contradicted by both cross-check sources")
    check(dist.get(3, 0) >= 6200, f"{dist.get(3, 0)} verses agree across all three sources")

    if problems:
        print(f"\nABORTING: {len(problems)} integrity check(s) failed; database not written.")
        return 1

    print("\n8. Writing data/bayan.db")
    corpus_lines = "".join(f"{k}\t{verifier.letters(verifier.verse_core(tanzil[k]))}\n" for k in ordered)
    corpus_sha = hashlib.sha256(corpus_lines.encode("utf-8")).hexdigest()

    if DB.exists():
        DB.unlink()
    con = sqlite3.connect(DB)
    con.executescript(
        """
        PRAGMA journal_mode=WAL;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE sources (
            id TEXT PRIMARY KEY, name TEXT, edition TEXT, url TEXT,
            license TEXT, role TEXT, sha256 TEXT, checked_at TEXT
        );
        CREATE TABLE surahs (
            number INTEGER PRIMARY KEY, name_ar TEXT, name_ar_short TEXT, name_en TEXT,
            meaning TEXT, ayahs INTEGER, revelation TEXT
        );
        CREATE TABLE verses (
            key TEXT PRIMARY KEY, surah INTEGER, ayah INTEGER, ordinal INTEGER,
            text_full TEXT, text_verse TEXT, basmala INTEGER,
            letters TEXT, search TEXT, letters_count INTEGER, consensus INTEGER, variants TEXT
        );
        CREATE TABLE source_text (
            verse_key TEXT, source TEXT, text TEXT, exact INTEGER, letters_equal INTEGER,
            PRIMARY KEY (verse_key, source)
        );
        CREATE TABLE translations (
            verse_key TEXT, lang TEXT, edition TEXT, translator TEXT, text TEXT,
            PRIMARY KEY (verse_key, lang, edition)
        );
        CREATE INDEX idx_verses_surah ON verses(surah, ayah);
        CREATE INDEX idx_verses_letters ON verses(letters);
        CREATE INDEX idx_tr_verse ON translations(verse_key);
        """
    )
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    con.executemany("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)", [
        ("tanzil", "Tanzil Project", "Uthmani 1.1", "https://tanzil.net/download/",
         "https://tanzil.net/docs/Text_License", "canonical", TANZIL_SHA256, now),
        ("quran_com", "Quran.com (Quran Foundation API)", "Uthmani", "https://api.quran.com",
         "https://quran.com", "cross-check", None, now),
        ("alquran_cloud", "Al Quran Cloud", "quran-uthmani", "https://alquran.cloud",
         "https://alquran.cloud", "cross-check", None, now),
    ])
    con.executemany(
        "INSERT INTO surahs VALUES (?,?,?,?,?,?,?)",
        [
            (
                s,
                meta_surahs[s]["name"],
                meta_surahs[s]["name"].replace("سُورَةُ ", "").strip(),
                meta_surahs[s]["englishName"],
                meta_surahs[s]["englishNameTranslation"],
                counts[s],
                revelation_label(meta_surahs[s]["revelationType"]),
            )
            for s in range(1, 115)
        ],
    )
    verse_rows = []
    for ordinal, key in enumerate(ordered):
        s, a = key_order(key)
        full = tanzil[key]
        bismillah = verifier.has_basmala(full) and key != "1:1"
        text_verse = verifier.verse_core(full) if bismillah else full
        # `letters` is the verification identity of the verse as displayed;
        # `search` indexes the full published line, so a basmala query finds all
        # 113 openers instead of only 1:1.
        verse_rows.append((
            key, s, a, ordinal, full, text_verse, 1 if bismillah else 0,
            verifier.letters(text_verse),
            verifier.letters(full),
            len(verifier.letters(text_verse)),
            consensus[key],
            ",".join(variants.get(key, [])),
        ))
    con.executemany("INSERT INTO verses VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", verse_rows)
    src_rows = []
    for key in ordered:
        src_rows.append((key, "tanzil", tanzil[key], 1, 1))
        for sid, text in (("quran_com", qc[key]), ("alquran_cloud", ac[key])):
            v = details[key][sid]
            src_rows.append((key, sid, text, 1 if v["exact"] else 0, 1 if v["letters_equal"] else 0))
    con.executemany("INSERT INTO source_text VALUES (?,?,?,?,?)", src_rows)
    tr_rows = []
    label_by_key = {(lang, ed): label for lang, ed, label in TRANSLATIONS}
    for key in ordered:
        for (lang, edition), rows in translations.items():
            tr_rows.append((key, lang, edition, label_by_key[(lang, edition)], rows[key]))
    con.executemany("INSERT INTO translations VALUES (?,?,?,?,?)", tr_rows)

    report = {
        "built_at": now,
        "tanzil_sha256": TANZIL_SHA256,
        "tanzil_keyed_sha256": keyed_sha,
        "corpus_sha256": corpus_sha,
        "surahs": 114,
        "verses": len(ordered),
        "consensus": {"three_of_three": dist.get(3, 0), "two_of_three": dist.get(2, 0), "one_of_three": dist.get(1, 0)},
        "variants": {
            k: {
                "disagrees_with": sids,
                "diff": [d for sid in sids for d in details[k][sid]["diff_tokens"]],
            }
            for k, sids in variants.items()
        },
        "letters_total": sum(row[9] for row in verse_rows),
    }
    con.executemany("INSERT INTO meta VALUES (?,?)", [
        ("built_at", now),
        ("corpus_sha256", corpus_sha),
        ("tanzil_sha256", TANZIL_SHA256),
        ("report", json.dumps(report, ensure_ascii=False)),
    ])
    con.commit()
    con.execute("PRAGMA optimize")
    con.close()
    (DATA / "build_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nDone. corpus sha256 {corpus_sha[:16]}...  variants: {len(variants)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
