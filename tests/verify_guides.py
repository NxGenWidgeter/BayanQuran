#!/usr/bin/env python3
"""Re-derive every claim the guides make, then (with --live) re-check the quotes.

Two kinds of check, deliberately separated:

  offline  the catalogue's shape: long enough to be a talk, one of the known
           categories, unique ids, the four tutorials present, each with at
           least two sources and an https URL.
  --live   each tutorial source is fetched again and its recorded quote must
           appear in the page text. This is the check that stops a tutorial
           drifting away from the page it claims to rest on, and it is the only
           one here that needs the network.
"""

from __future__ import annotations

import argparse
import html
import re
import subprocess
import time
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import guides  # noqa: E402

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)


def flat(text: str) -> str:
    """Compare text the way a reader would: whitespace and quotes are not content."""
    text = unicodedata.normalize("NFC", text)
    for a, b in (("\u201c", '"'), ("\u201d", '"'), ("\u2019", "'"), ("\u2018", "'"), ("\u00a0", " ")):
        text = text.replace(a, b)
    text = re.sub(r"-\s*\n\s*", "-", text)  # pdftotext splits hyphenated words
    text = re.sub(r"\s+", " ", text).strip().lower()
    # Stripping tags leaves "tidur ." where the page renders "tidur." — spacing
    # before punctuation is an extraction artefact, not a difference in words.
    text = re.sub(r"\s+([.,;:!?»”)\]])", r"\1", text)
    return re.sub(r"([«“‘(\[])\s+", r"\1", text)


def offline(payload: dict) -> None:
    print("catalogue")
    videos = payload["videos"]
    check("videos present", len(videos) > 0, f"{len(videos)} videos")
    check("no duplicate ids", len({v["id"] for v in videos}) == len(videos))
    check("every id is 11 characters", all(len(v["id"]) == 11 for v in videos))
    short = [v["id"] for v in videos if v["duration_s"] < guides.MIN_DURATION_S]
    check("every video is at least 15 minutes", not short, f"{len(short)} too short")
    bad_cat = [v["id"] for v in videos if v["category"] not in guides.CATEGORY_IDS]
    check("every video has a known category", not bad_cat, f"{len(bad_cat)} unknown")
    check(
        "counts add up",
        sum(payload["counts"][c] for c in guides.CATEGORY_IDS) == len(videos),
        str({c: payload["counts"][c] for c in guides.CATEGORY_IDS if payload["counts"][c]}),
    )
    check("channel recorded", bool(payload["channel"]["channel_id"]), payload["channel"].get("name", ""))

    print("tutorials")
    solat = payload["solat"]
    check("four tutorials", [s["id"] for s in solat] == guides.SOLAT_IDS, ", ".join(s["id"] for s in solat))
    for t in solat:
        sumber = t["sumber"]
        check(f"{t['id']}: at least two sources", len(sumber) >= 2, f"{len(sumber)}")
        check(f"{t['id']}: all sources https", all(str(s.get("url", "")).startswith("https://") for s in sumber))
        check(f"{t['id']}: has prose and steps", bool(t["ringkasan"]) and bool(t["langkah"]), f"{len(t['langkah'])} steps")
        # A null Arabic niat is allowed, but it must be explained rather than silently absent.
        if not (t.get("niat") or {}).get("ar"):
            check(f"{t['id']}: null Arabic niat is explained", bool(t.get("nota")), (t.get("nota") or "")[:60])


def fetch(url: str, timeout: int = 90, attempts: int = 3) -> bytes:
    """Fetch with retries: a 4 MB JAKIM PDF answered with IncompleteRead once, and a
    transient DNS miss should not be reported as a missing quote."""
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ms,en;q=0.8"})
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
        except Exception as err:  # URLError, HTTPException, IncompleteRead, gaierror...
            last = err
            time.sleep(2 * (attempt + 1))
    raise last if last else RuntimeError("fetch failed")


def page_text(body: bytes) -> str:
    """HTML as words; a PDF is converted with pdftotext rather than decoded as bytes.

    Two tutorials cite JAKIM's Qiamullail booklet, which is a PDF — decoding it as
    text would have made every one of those quotes look missing.
    """
    if body[:4] == b"%PDF":
        with tempfile.NamedTemporaryFile(suffix=".pdf") as fh:
            fh.write(body)
            fh.flush()
            out = subprocess.run(["pdftotext", "-layout", fh.name, "-"], capture_output=True, text=True)
        if out.returncode != 0:
            raise RuntimeError("pdftotext failed: " + out.stderr.strip()[:160])
        return out.stdout
    raw = body.decode("utf-8", errors="replace")
    raw = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", raw)
    raw = re.sub(r"<[^>]+>", " ", raw)
    return html.unescape(raw)


def live(payload: dict) -> None:
    print("live quote check (each source is fetched again)")
    for t in payload["solat"]:
        for s in t["sumber"]:
            url = s["url"]
            try:
                body = flat(page_text(fetch(url)))
            except Exception as err:  # network shape varies: report, never crash
                check(f"{t['id']}: {s.get('nama', url)}", False, f"unreachable — {err}")
                continue
            quote = flat(s.get("quote", ""))
            if quote not in body and "web.archive.org" in url and "id_/" in url:
                # Wayback's raw form is flaky under load; the reader-facing form usually answers.
                try:
                    body = flat(page_text(fetch(url.replace("id_/", ""))))
                except Exception:
                    pass
            found = bool(quote) and quote in body
            check(
                f"{t['id']}: {s.get('nama', url)}",
                found,
                f"{len(quote)} chars quoted" if found else "quote NOT found in the page",
            )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="re-fetch every source and re-check its quote")
    args = ap.parse_args()

    try:
        payload = guides.load()
    except ValueError as err:
        print(f"FAIL catalogue is inconsistent:\n{err}")
        return 1

    offline(payload)
    if args.live:
        live(payload)

    print()
    if FAILS:
        print(f"{len(FAILS)} check(s) failed: {', '.join(FAILS)}")
        return 1
    print("guides are consistent" + (" and every quote re-checked live" if args.live else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
