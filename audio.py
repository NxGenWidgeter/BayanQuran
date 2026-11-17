"""Recitation audio: download a surah's verses, one file per ayah.

Per-ayah files are why the transcript can be trusted: the audio for verse 12:39 is
the file for verse 12:39, so nothing has to be inferred from timestamps. Playback
walks the verse list and the list is the transcript.

Files land in data/audio/<edition>/<surah>/<ayah>.mp3 next to a manifest, so a
downloaded surah plays with no network at all.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB = ROOT / "data" / "bayan.db"
AUDIO = ROOT / "data" / "audio"
CDN = "https://cdn.islamic.network/quran/audio/{bitrate}/{edition}/{number}.mp3"
UA = "Bayan/1.0 (local Quran reader)"

EDITIONS = {
    "ar.alafasy": {"name": "Mishary Alafasy", "note": "murattal"},
    "ar.husary": {"name": "Mahmoud Khalil Al-Husary", "note": "murattal"},
    "ar.abdulbasitmurattal": {"name": "Abdul Basit", "note": "murattal"},
    "ar.abdurrahmaansudais": {"name": "Abdurrahman As-Sudais", "note": "murattal"},
}
DEFAULT_EDITION = "ar.alafasy"
DEFAULT_BITRATE = 64

# Rough size for "how big is this?" before anything is fetched: measured against
# Ya-Sin (83 verses, 8.2 MB) and Al-Ikhlas at 64 kbps, which works out near 100 KB
# per verse. Good enough for an estimate, never used for anything exact.
BYTES_PER_AYAH = 100 * 1024

_jobs: dict[tuple[str, int], dict] = {}
_jobs_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bayan-audio")


def edition_info(edition: str) -> dict:
    if edition not in EDITIONS:
        raise KeyError(edition)
    return {"id": edition, **EDITIONS[edition], "bitrate": DEFAULT_BITRATE}


def surah_dir(edition: str, surah: int) -> Path:
    return AUDIO / edition / f"{surah:03d}"


def verse_path(edition: str, surah: int, ayah: int) -> Path:
    return surah_dir(edition, surah) / f"{ayah:03d}.mp3"


def manifest_path(edition: str, surah: int) -> Path:
    return surah_dir(edition, surah) / "manifest.json"


def global_numbers(surah: int) -> dict[int, int]:
    """ayah number -> global ayah number (1..6236), which is what the CDN names."""
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT ayah, ordinal FROM verses WHERE surah=? ORDER BY ayah", (surah,)
        ).fetchall()
    finally:
        con.close()
    return {ayah: ordinal + 1 for ayah, ordinal in rows}


def local_state(edition: str, surah: int) -> dict:
    """What is already on disk for this surah."""
    numbers = global_numbers(surah)
    present, missing, total_bytes = [], [], 0
    for ayah in numbers:
        path = verse_path(edition, surah, ayah)
        if path.exists() and path.stat().st_size > 0:
            present.append(ayah)
            total_bytes += path.stat().st_size
        else:
            missing.append(ayah)
    manifest = None
    if manifest_path(edition, surah).exists():
        try:
            manifest = json.loads(manifest_path(edition, surah).read_text())
        except ValueError:
            manifest = None
    return {
        "edition": edition,
        "surah": surah,
        "ayahs": len(numbers),
        "present": len(present),
        "missing": missing,
        "complete": not missing,
        "bytes": total_bytes,
        "manifest": manifest,
    }


def urls_for(edition: str, surah: int) -> dict[str, str]:
    """Local file if downloaded, CDN otherwise, so playback works either way."""
    numbers = global_numbers(surah)
    out: dict[str, str] = {}
    for ayah, number in numbers.items():
        if verse_path(edition, surah, ayah).exists():
            out[str(ayah)] = f"/audio/{edition}/{surah:03d}/{ayah:03d}.mp3"
        else:
            out[str(ayah)] = CDN.format(bitrate=DEFAULT_BITRATE, edition=edition, number=number)
    return out


def _fetch(url: str, dest: Path, tries: int = 3) -> int:
    last: Exception | None = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
            if not body:
                raise ValueError("empty body")
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(".part")
            tmp.write_bytes(body)
            os.replace(tmp, dest)
            return len(body)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as exc:
            last = exc
            time.sleep(1.0 + attempt)
    raise RuntimeError(f"{url}: {last}")


def job_state(edition: str, surah: int) -> dict | None:
    with _jobs_lock:
        job = _jobs.get((edition, surah))
        return dict(job) if job else None


def start_download(edition: str, surah: int) -> dict:
    """Queue a surah for download (idempotent while one is running)."""
    edition_info(edition)
    with _jobs_lock:
        job = _jobs.get((edition, surah))
        if job and job["state"] in ("queued", "running"):
            return dict(job)
    numbers = global_numbers(surah)
    if not numbers:
        raise KeyError(f"no verses for surah {surah}")
    with _jobs_lock:
        _jobs[(edition, surah)] = {
            "edition": edition,
            "surah": surah,
            "state": "queued",
            "done": 0,
            "total": len(numbers),
            "bytes": 0,
            "error": None,
            "started": None,
            "finished": None,
        }
    _pool.submit(_run_download, edition, surah, numbers)
    return job_state(edition, surah) or {}


def _run_download(edition: str, surah: int, numbers: dict[int, int]) -> None:
    key = (edition, surah)
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _jobs_lock:
        _jobs[key].update(state="running", started=started)

    todo = [a for a in numbers if not (verse_path(edition, surah, a).exists() and verse_path(edition, surah, a).stat().st_size)]
    done = len(numbers) - len(todo)
    total_bytes = sum(
        verse_path(edition, surah, a).stat().st_size for a in numbers
        if verse_path(edition, surah, a).exists()
    )

    def work(ayah: int) -> tuple[int, int]:
        number = numbers[ayah]
        size = _fetch(
            CDN.format(bitrate=DEFAULT_BITRATE, edition=edition, number=number),
            verse_path(edition, surah, ayah),
        )
        return ayah, size

    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(work, a): a for a in todo}
            for future in as_completed(futures):
                ayah, size = future.result()
                done += 1
                total_bytes += size
                with _jobs_lock:
                    _jobs[key].update(done=done, bytes=total_bytes)

        manifest = {
            "edition": edition,
            "surah": surah,
            "bitrate": DEFAULT_BITRATE,
            "ayahs": len(numbers),
            "bytes": total_bytes,
            "source": CDN.format(bitrate=DEFAULT_BITRATE, edition=edition, number="{number}"),
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        manifest_path(edition, surah).write_text(json.dumps(manifest, indent=2))
        with _jobs_lock:
            _jobs[key].update(
                state="done",
                done=len(numbers),
                bytes=total_bytes,
                finished=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            )
    except Exception as exc:  # surfaced to the UI, never swallowed
        with _jobs_lock:
            _jobs[key].update(
                state="error",
                error=f"{type(exc).__name__}: {exc}",
                finished=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            )


def delete_surah(edition: str, surah: int) -> dict:
    directory = surah_dir(edition, surah)
    removed = 0
    if directory.exists():
        for path in directory.glob("*.mp3"):
            path.unlink(missing_ok=True)
            removed += 1
        manifest_path(edition, surah).unlink(missing_ok=True)
    with _jobs_lock:
        _jobs.pop((edition, surah), None)
    return {"removed": removed}


def downloaded_surahs(edition: str) -> list[int]:
    base = AUDIO / edition
    if not base.exists():
        return []
    out = []
    for directory in sorted(base.iterdir()):
        if directory.is_dir() and manifest_path(edition, int(directory.name)).exists():
            out.append(int(directory.name))
    return out
