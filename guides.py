#!/usr/bin/env python3
"""The readers' guides: Ustaz Azhar Idrus's talks and the solat sunat tutorials.

Two hand-curated files under ``guides/`` feed one payload:

    guides/videos.json   long-form videos from the official YouTube channel
    guides/solat.json    four Malay tutorials, each claim carrying the URL and
                         the verbatim sentence it came from

Unlike ``data/``, these files are tracked in git and never generated, because
both are judgement calls rather than downloads: which talk belongs in which
category, and which sourced sentence a tutorial sentence rests on. The video
metadata is what YouTube reported at curation time; nothing here is invented,
and ``validate()`` refuses a catalogue that has drifted (a video too short to be
a full talk, an unknown category, a duplicate id, a tutorial with no sources).

The app serves the videos through YouTube's own embed. Nothing is downloaded or
re-hosted: the talks stay on the channel that published them, the view counts
stay his, and the web edition works with no server of its own.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GUIDES = ROOT / "guides"
VIDEOS = GUIDES / "videos.json"
SOLAT = GUIDES / "solat.json"

# Order matters: it is the order of the filter chips in the UI, from the thing
# the collection was asked for (khutbah) to the things around it.
CATEGORIES = [
    ("khutbah_jumaat", "Khutbah Jumaat"),
    ("khutbah_eid", "Khutbah Raya"),
    ("kuliyyah", "Kuliyyah & Ceramah"),
    ("soal_jawab", "Soal Jawab"),
    ("tazkirah", "Tazkirah"),
    ("other", "Lain-lain"),
]
CATEGORY_IDS = {cid for cid, _ in CATEGORIES}
CATEGORY_LABEL = dict(CATEGORIES)

# Shorter than this is a clip, not a talk. A collection of two-minute answers
# would misrepresent "khutbah session" as something you can sit down to.
MIN_DURATION_S = 900

SOLAT_IDS = ["rawatib", "dhuha", "tahajjud", "witir"]

WATCH = "https://www.youtube.com/watch?v={id}"
EMBED = "https://www.youtube-nocookie.com/embed/{id}?rel=0&modestbranding=1"


def _read(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def _clean_video(raw: dict, problems: list[str], channel_id: str) -> dict:
    vid = str(raw.get("id", "")).strip()
    if len(vid) != 11:
        problems.append(f"video id {vid!r} is not 11 characters")
    category = raw.get("category")
    if category not in CATEGORY_IDS:
        problems.append(f"{vid}: unknown category {category!r}")
    duration = raw.get("duration_s")
    if not isinstance(duration, int):
        problems.append(f"{vid}: duration_s must be an integer")
        duration = 0
    elif duration < MIN_DURATION_S:
        problems.append(f"{vid}: {duration}s is shorter than the {MIN_DURATION_S}s floor")
    if raw.get("channel_id") and raw["channel_id"] != channel_id:
        problems.append(f"{vid}: channel_id {raw['channel_id']!r} is not {channel_id!r}")
    return {
        "id": vid,
        "title": str(raw.get("title", "")).strip(),
        "duration_s": duration,
        "upload_date": raw.get("upload_date") or None,
        "category": category,
        "category_label": CATEGORY_LABEL.get(category, ""),
        "url": WATCH.format(id=vid),
        "embed": EMBED.format(id=vid),
        "view_count": raw.get("view_count"),
        "notes": raw.get("notes") or "",
    }


def _clean_solat(raw: dict, problems: list[str]) -> dict:
    sid = raw.get("id")
    sumber = raw.get("sumber") or []
    if not isinstance(sumber, list) or len(sumber) < 2:
        problems.append(f"solat {sid}: needs at least 2 sumber entries")
    for s in sumber:
        if not str(s.get("url", "")).startswith("https://"):
            problems.append(f"solat {sid}: source url is not https: {s.get('url')!r}")
        if not s.get("quote"):
            problems.append(f"solat {sid}: source {s.get('nama')!r} has no verbatim quote")
    return {
        "id": sid,
        "nama": raw.get("nama", ""),
        "ringkasan": raw.get("ringkasan", ""),
        "hukum": raw.get("hukum", ""),
        "rakaat": raw.get("rakaat", ""),
        "waktu": raw.get("waktu", ""),
        "niat": raw.get("niat") or {"ar": None, "rumi": None, "ms": None},
        "langkah": raw.get("langkah") or [],
        "fadhilat": raw.get("fadhilat") or [],
        "sumber": sumber,
        "nota": raw.get("nota", ""),
    }


def load(strict: bool = True) -> dict:
    """-> the payload the UI consumes; raises ValueError when strict and invalid."""
    problems: list[str] = []

    if not VIDEOS.exists():
        problems.append("guides/videos.json is missing")
        videos_raw: list[dict] = []
        channel: dict = {}
    else:
        blob = _read(VIDEOS)
        channel = blob.get("channel") or {}
        videos_raw = blob.get("videos") or []
        if not channel.get("channel_id"):
            problems.append("channel_id is missing from guides/videos.json")
        if not videos_raw:
            problems.append("guides/videos.json lists no videos")

    channel_id = str(channel.get("channel_id", ""))
    seen: set[str] = set()
    videos: list[dict] = []
    for raw in videos_raw:
        video = _clean_video(raw, problems, channel_id)
        if video["id"] in seen:
            problems.append(f"duplicate video id {video['id']}")
        seen.add(video["id"])
        videos.append(video)

    order = {cid: i for i, (cid, _) in enumerate(CATEGORIES)}
    videos.sort(key=lambda v: (order.get(v["category"], 99), v["upload_date"] or "", v["title"]))

    if not SOLAT.exists():
        problems.append("guides/solat.json is missing")
        solat_raw: list[dict] = []
    else:
        solat_raw = _read(SOLAT)
        if not isinstance(solat_raw, list):
            problems.append("guides/solat.json must be an array")
            solat_raw = []
    solat = [_clean_solat(raw, problems) for raw in solat_raw]
    if [s["id"] for s in solat] != SOLAT_IDS:
        problems.append(f"solat ids are {[s['id'] for s in solat]}, expected {SOLAT_IDS}")

    counts = {cid: 0 for cid in CATEGORY_IDS}
    for v in videos:
        if v["category"] in counts:
            counts[v["category"]] += 1

    if problems and strict:
        raise ValueError("guides are not consistent:\n  " + "\n  ".join(problems))

    built = max(
        (p.stat().st_mtime for p in (VIDEOS, SOLAT) if p.exists()), default=0
    )
    return {
        "ok": not problems,
        "problems": problems,
        "channel": {
            "name": channel.get("name", ""),
            "url": channel.get("url", ""),
            "channel_id": channel_id,
            "verified_at": channel.get("verified_at"),
            "note": channel.get("note", ""),
        },
        "categories": [
            {"id": cid, "label": label, "count": counts[cid]} for cid, label in CATEGORIES
        ],
        "counts": {"total": len(videos), **counts},
        "min_duration_s": MIN_DURATION_S,
        "videos": videos,
        "solat": solat,
        "built_at": datetime.fromtimestamp(built, tz=timezone.utc).isoformat(timespec="seconds")
        if built
        else None,
        "sumber_nota": (
            "Setiap video dipautkan ke YouTube dan dimainkan melalui pemain rasmi YouTube, "
            "bukan dimuat turun atau disimpan semula. Setiap panduan solat menyebut sumber "
            "asalnya (JAKIM, Pejabat Mufti Wilayah Persekutuan, sunnah.com) berserta petikan "
            "yang boleh disemak sendiri."
        ),
    }


if __name__ == "__main__":
    payload = load()
    print(f"{payload['counts']['total']} videos from {payload['channel']['name']}")
    for c in payload["categories"]:
        print(f"  {c['count']:>3}  {c['label']}")
    print(f"{len(payload['solat'])} solat tutorials")
