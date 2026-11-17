# BayanQuran بيان

A local Quran reader whose point is proof: pick any verse, and the app shows you
the same verse as published by three separate digitisation projects, compares them
letter by letter, and can re-fetch all three live while you watch.

Runs entirely on this machine. Nothing leaves it except the requests you trigger.

```
./run.sh            # service on http://127.0.0.1:8150
./run.sh --open     # same, in your browser
./run.sh --stop
```

## What "verified" means here

Every verse is checked at build time against three published Uthmani editions:

| Source | Edition | Role |
| --- | --- | --- |
| [Tanzil Project](https://tanzil.net/download/) | Uthmani 1.1 | canonical text |
| [Quran.com / Quran Foundation API](https://api.quran.com) | Uthmani | cross-check |
| [Al Quran Cloud](https://alquran.cloud) | quran-uthmani | cross-check |

The build:

1. Downloads the Tanzil file and proves its **SHA-256 against the published
   checksum** (`ac0724…67af`, 1,334,737 bytes). The keyed variant is downloaded too
   and asserted line-for-line identical, so the corpus has both the checksum and
   the verse references.
2. Downloads all 6,236 verses from Quran.com and the whole Quran from Al Quran
   Cloud, and asserts the three key sets are identical.
3. Checks structure: 114 surahs, 6,236 verses, per-surah ayah counts equal to the
   published table, no gaps in numbering, 113 basmala lines (1:1 plus 112 surah
   openers, none in At-Tawbah).
4. Compares every verse across the three sources on its **consonantal text**:
   marks, tatweel, hamza placement and word spacing are allowed to differ (they
   legitimately do between publishers); the letters must not.
5. Refuses to write a database if any assertion fails.

Result of the current build: **6,234 of 6,236 verses agree across all three
sources**; two verses (`12:39`, `12:41`) agree in two of three. In both, Al Quran
Cloud prints `يَٰصَىٰحِبَىِ` where Tanzil and Quran.com print `يَٰصَٰحِبَىِ` — a
`ى` where the word has a `ح`. The app shows that difference in place, marks the
differing word in the offending edition, and keeps the reading two sources confirm.

Any verse can be re-checked live from the inspector: Tanzil's whole file is
re-downloaded and re-hashed, and the two APIs are queried for that single verse.
The verdict never consults the cached corpus.

## Recitation and transcript

Any surah can be recited with its verses acting as the transcript. The audio is
one MP3 per ayah, so the transcript is exact by construction — no timestamps are
guessed: verse 12:39 is the file for 12:39, and the reader highlights and scrolls
to whichever verse is sounding.

- Four reciters (Alafasy, Husary, Abdul Basit, As-Sudais) at 64 kbps, from the
  Islamic Network CDN (`cdn.islamic.network`).
- **Listen** streams immediately; **Download** saves every verse of the surah to
  `data/audio/<reciter>/<surah>/` so it plays with no network afterwards. A ♪
  beside the surah number in the sidebar means the recitation is on disk.
- **Transcript** saves the surah's Arabic and translation as a `.txt` file.
- Playback never hard-stops: the last verse fades down as it ends and the next
  surah fades up, so listening runs on uninterrupted (114 wraps back to 1).
  Built for falling asleep to it — a cut at 2am does the opposite of the job.
- Downloaded audio is ~100 KB per verse; the whole Quran is about 610 MB.

```
./download_audio.py --surahs 1,18,36,55,67,78,112-114
./download_audio.py --all                      # about 610 MB, ~25 min
./download_audio.py --list
./download_audio.py --remove 18
```

The recitation is **not** part of the text verification. Files come from a
different provider and are matched to verses by ayah number; the checksum and
cross-source work above says nothing about them.

## Reading it online

`export_static.py` writes the whole reader out as files — no server, no install:

    https://nxgenwidgeter.github.io/BayanQuran/

Every `/api/*` payload is exported once, and `static/site.js` answers the same
routes from those JSON files in the browser. Nothing is faked: the verse texts,
the three editions, the diffs and the consensus counts are the build's own
output, search runs client-side over the same index, and Quran.com and Al Quran
Cloud are queried live when you press **Re-check live**. Two things a browser
cannot do without a server, and the web edition says so where it matters:

- re-download tanzil.net — it sends no CORS header, so Tanzil's verdict is the
  build-time one, labelled "checked at build time" beside its sha256;
- pull the MP3s into browser storage — the CDN sends no CORS header either, so
  the web edition streams and offline downloads stay a feature of the local app.

```
./publish_site.sh          # build dist-site/ and push it to the gh-pages branch
./export_static.py         # build only, for inspection in dist-site/
```

The page is one document with no CDN and no build step: it works offline once
cached by the browser, and it is the same `static/` the local app serves.

## Layout

```
build_corpus.py       fetch, verify, build data/bayan.db (--refresh / --offline)
verifier.py           normalisation and comparison rules
audio.py              per-ayah recitation: download, manifest, local/CDN urls
download_audio.py     bulk downloader CLI
app.py                FastAPI service, 127.0.0.1 only
export_static.py      writes the reader out as a static site (dist-site/)
publish_site.sh       builds and publishes dist-site/ to the gh-pages branch
static/               one page, no framework, no CDN
static/site.js        the /api contract answered from exported JSON, in the browser
tests/verify_corpus.py  re-derives every claim from the database, then the API
data/                 bayan.db, raw downloads, audio (rebuildable, not tracked)
```

The service refuses any client that is not loopback, and binds `127.0.0.1` only.
`ss -ltnp` shows `127.0.0.1:8150`; the machine's LAN address refuses the
connection.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/status` | provenance, totals, variants, integrity checks run now |
| `GET /api/surahs` | 114 surahs with names, counts, revelation place |
| `GET /api/surah/{n}` | verses of one surah with translations |
| `GET /api/verse/{s}:{a}` | verse, both translations, all three source texts, diffs |
| `GET /api/search?q=` | Arabic letters (diacritic-insensitive) or translation text |
| `GET /api/random` | a verse key |
| `GET /api/verify/{s}:{a}` | live re-fetch of all three sources and the verdict |
| `GET /api/audio/config` | reciters, bitrate, which surahs are downloaded |
| `GET /api/audio/{n}` | per-verse audio urls (local or CDN) + download state |
| `POST /api/audio/{n}/download` | fetch every verse of a surah for offline playback |
| `GET /api/audio/{n}/status` | download progress |
| `DELETE /api/audio/{n}` | delete that surah's audio |
| `GET /audio/...` | the MP3 files themselves (range requests supported) |

## Rebuilding

```
python3 build_corpus.py            # uses data/raw, fetches what is missing
python3 build_corpus.py --refresh  # re-downloads everything
python3 build_corpus.py --offline  # no network, cache only
python3 tests/verify_corpus.py     # database + API; add --live for a network check
```

Rebuild after any change to `verifier.py`: the stored match flags and consensus
counts are products of those rules.

## Limits, stated plainly

- Translation is interpretation, not the Quran. English is Saheeh International
  and Malay is Basmeih (Tafsir Pimpinan ar-Rahman), both fetched from Al Quran
  Cloud and shown with the translator named. Check the editions' terms before
  redistributing them.
- Arabic text is reproduced unmodified from the Tanzil Project under its terms:
  verbatim copying only, source credited, link to tanzil.net kept. The text may
  not be altered.
- Verse numbering follows the Hafs/Kufan count (6,236). Other counting traditions
  number some verses differently; no attempt is made to map them.
- "Agreement on the consonantal text" deliberately ignores diacritics. Two
  editions can share letters and still differ in vowelling; that is not analysed
  here.
- The live check needs the network. Tanzil re-downloads 1.3 MB each time, so that
  step can take a minute.
- Recitation is streamed from a third party or served from `data/audio/`; it is
  matched to verses by ayah number and is not covered by the text verification.

## Fonts

`static/fonts/` carries Amiri Quran (SIL Open Font License 1.1, © Khaled Hosny),
subset by Google Fonts, so the mushaf-style text renders the same everywhere.
