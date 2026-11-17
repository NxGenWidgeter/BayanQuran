#!/usr/bin/env python3
"""Download Quran recitation, one file per verse.

    ./download_audio.py --surahs 1,18,36,55,67      # what you ask for
    ./download_audio.py --all                       # the whole Quran
    ./download_audio.py --all --edition ar.husary
    ./download_audio.py --list                      # what is already on disk
    ./download_audio.py --remove 18                 # reclaim the space

Files go to data/audio/<edition>/<surah>/<ayah>.mp3 and are served by the app at
/audio/…, so a downloaded surah plays with no network. The app itself can do this
per surah from the reader; this script is for doing many at once.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

import audio

ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "bayan.db"


def surah_names() -> dict[int, str]:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return {n: name for n, name in con.execute("SELECT number, name_en FROM surahs")}
    finally:
        con.close()


def fmt_bytes(n: float) -> str:
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.2f} GB"
    if n >= 1024 ** 2:
        return f"{n / 1048576:.1f} MB"
    return f"{max(1, round(n / 1024))} KB"


def total_ayahs() -> int:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return con.execute("SELECT COUNT(*) FROM verses").fetchone()[0]
    finally:
        con.close()


def progress(job: dict, width: int = 28) -> str:
    total = job.get("total") or 1
    done = job.get("done") or 0
    filled = int(width * done / total)
    return f"[{'#' * filled}{'.' * (width - filled)}] {done}/{total}  {fmt_bytes(job.get('bytes') or 0)}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--edition", default=audio.DEFAULT_EDITION)
    ap.add_argument("--surahs", help="comma-separated surah numbers, or ranges like 1-10")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--remove", help="comma-separated surah numbers to delete")
    ap.add_argument("--skip-existing", action="store_true", default=True)
    args = ap.parse_args()

    if args.edition not in audio.EDITIONS:
        print(f"unknown reciter. choose from: {', '.join(audio.EDITIONS)}", file=sys.stderr)
        return 2

    names = surah_names()

    if args.list:
        done = audio.downloaded_surahs(args.edition)
        print(f"{args.edition}: {len(done)} surahs on disk")
        for n in done:
            state = audio.local_state(args.edition, n)
            print(f"  {n:>3} {names.get(n, '?'):<28} {state['ayahs']:>3} verses  {fmt_bytes(state['bytes'])}")
        return 0

    if args.remove:
        for n in parse_list(args.remove):
            out = audio.delete_surah(args.edition, n)
            print(f"removed {out['removed']} files for surah {n}")
        return 0

    if args.all:
        todo = list(range(1, 115))
    elif args.surahs:
        todo = parse_list(args.surahs)
    else:
        ap.print_help()
        return 2

    print(f"{args.edition} · {fmt_bytes(audio.BYTES_PER_AYAH * total_ayahs())} projected for the whole Quran at {audio.DEFAULT_BITRATE} kbps")
    started = time.time()
    failed = []
    for n in todo:
        if not 1 <= n <= 114:
            print(f"skip {n}: not a surah")
            continue
        state = audio.local_state(args.edition, n)
        if state["complete"]:
            print(f"{n:>3} {names.get(n, ''):<28} already complete ({fmt_bytes(state['bytes'])})")
            continue
        audio.start_download(args.edition, n)
        last = -1
        while True:
            job = audio.job_state(args.edition, n) or {}
            if job.get("done") != last or job.get("state") in ("done", "error"):
                print(f"\r{n:>3} {names.get(n, ''):<28} {progress(job)}", end="", flush=True)
                last = job.get("done")
            if job.get("state") in ("done", "error"):
                break
            time.sleep(0.5)
        print()
        if job.get("state") == "error":
            failed.append(n)
            print(f"    failed: {job.get('error')}")

    elapsed = time.time() - started
    done = audio.downloaded_surahs(args.edition)
    size = sum(audio.local_state(args.edition, n)["bytes"] for n in done)
    print(f"\nfinished in {elapsed:.0f}s · {len(done)} surahs on disk · {fmt_bytes(size)}")
    if failed:
        print(f"failed surahs: {failed}", file=sys.stderr)
        return 1
    return 0


def parse_list(spec: str) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return out


if __name__ == "__main__":
    sys.exit(main())
