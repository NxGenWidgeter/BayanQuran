/* Bayan static edition — the same /api contract, answered from exported JSON.
 *
 * export_static.py writes every endpoint's payload to data/. Nothing here is a
 * mock: the surah texts, the three source editions, the diffs, the consensus
 * counts and the integrity report are the build's real output. What a browser
 * cannot do without a server:
 *
 *   - re-download tanzil.net (it sends no CORS header) — so the Tanzil verdict
 *     shown is the one the build made, against the published sha256;
 *   - write MP3s to a server disk — the CDN sends no CORS header either, so
 *     audio streams and cannot be cached for offline playback.
 *
 * Search, verse inspection and the two live APIs run in the browser for real.
 */
(() => {
  "use strict";

  window.BAYAN_STATIC = true;

  const realFetch = window.fetch.bind(window);
  const DATA = new URL("data/", document.baseURI);
  const CDN = "https://cdn.islamic.network/quran/audio/{bitrate}/{edition}/{number}.mp3";

  /* ---------- normalisation, ported from verifier.py ---------- */

  const DROPPED = new Set(["\u0640", "\u06dd", "\u06de", "\u06e9", "\u06e5", "\u06e6", "\u0621"]);
  const FOLD = new Map([
    [0x0623, "\u0627"], // أ
    [0x0625, "\u0627"], // إ
    [0x0622, "\u0627"], // آ
    [0x0671, "\u0627"], // ٱ
    [0x0672, "\u0627"], // ٲ
    [0x0673, "\u0627"], // ٳ
    [0x0624, "\u0648"], // ؤ
    [0x0626, "\u064a"], // ئ
    [0x0649, "\u064a"], // ى
  ]);
  const BASMALA_RAW = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ";

  function letters(text) {
    let out = "";
    for (const ch of text.normalize("NFC")) {
      if (DROPPED.has(ch) || /\s/.test(ch)) continue;
      if (/[\p{Mn}\p{Me}\p{Cf}]/u.test(ch)) continue;
      out += FOLD.get(ch.codePointAt(0)) || ch;
    }
    return out;
  }

  const BASMALA_LETTERS = letters(BASMALA_RAW);

  function verseCore(text) {
    const tokens = text.trim().split(/\s+/);
    if (tokens.length > 4 && letters(tokens.slice(0, 4).join(" ")) === BASMALA_LETTERS) {
      return tokens.slice(4).join(" ").trim();
    }
    return text.trim();
  }

  /* ---------- data loading ---------- */

  const json = new Map();
  async function load(path) {
    if (!json.has(path)) {
      json.set(
        path,
        realFetch(new URL(path, DATA), { cache: "no-cache" }).then((res) => {
          if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
          return res.json();
        }),
      );
      json.get(path).catch(() => json.delete(path)); // let a failure be retried
    }
    return json.get(path);
  }

  const surahPath = (n) => `surah/${String(Number(n)).padStart(3, "0")}.json`;
  const meta = async () => {
    if (!json.has("__meta")) {
      const [status, surahs] = await Promise.all([load("status.json"), load("surahs.json")]);
      json.set("__meta", Promise.resolve({ status, surahs }));
    }
    return json.get("__meta");
  };

  /* ---------- endpoints ---------- */

  async function apiStatus() {
    return (await meta()).status;
  }

  async function apiSurahs() {
    return (await meta()).surahs;
  }

  async function apiSurah(number) {
    const payload = await load(surahPath(number));
    // The static payload also carries the three source texts; the reader only
    // needs the verse list, and keeps the rest for the inspector.
    return {
      surah: payload.surah,
      verses: payload.verses.map((v) => ({
        key: v.key,
        ayah: v.ayah,
        text: v.text,
        basmala: v.basmala,
        consensus: v.consensus,
        variants: v.variants,
        letters: v.letters,
        translations: v.translations,
      })),
    };
  }

  async function apiVerse(key) {
    const [surahNo] = String(key).split(":");
    const [payload, detail] = await Promise.all([
      load(surahPath(surahNo)),
      load(`sources/${String(Number(surahNo)).padStart(3, "0")}.json`),
    ]);
    const v = payload.verses.find((x) => x.key === key);
    const d = detail[key];
    if (!v || !d) throw Object.assign(new Error(`${key} is not a verse in the corpus`), { status: 404 });
    return {
      verse: {
        key: v.key,
        surah: payload.surah.number,
        ayah: v.ayah,
        text_full: d.text_full,
        text: v.text,
        basmala: v.basmala,
        letters: v.letters,
        consensus: v.consensus,
        variants: v.variants,
        translations: v.translations,
      },
      surah: payload.surah,
      sources: d.sources,
      prev: d.prev,
      next: d.next,
    };
  }

  let searchIndex = null;
  async function apiSearch(rawQ, limit = 40) {
    const q = String(rawQ || "").trim();
    if (q.length < 2) return { query: q, results: [], mode: null };
    const [index, surahs] = await Promise.all([load("search.json"), apiSurahs()]);
    if (!searchIndex) {
      searchIndex = index.verses.map((r) => ({ key: r[0], consensus: r[1], text: r[2], en: r[3], ms: r[4], basmala: !!r[5], letters: null }));
    }
    const arabicQ = letters(q);
    const looksArabic = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/.test(q);
    const mode = looksArabic && arabicQ.length >= 2 ? "arabic" : "translation";
    const bySurah = new Map(surahs.map((s) => [s.number, s]));
    const needle = q.toLowerCase();
    const results = [];
    for (const row of searchIndex) {
      if (results.length >= limit) break;
      let snippet = "";
      if (mode === "arabic") {
        if (row.letters === null) row.letters = (row.basmala ? BASMALA_LETTERS : "") + letters(row.text);
        if (!row.letters.includes(arabicQ)) continue;
      } else {
        const en = row.en.toLowerCase();
        const ms = row.ms.toLowerCase();
        const at = en.indexOf(needle);
        const a2 = ms.indexOf(needle);
        if (at === -1 && a2 === -1) continue;
        const src = at !== -1 ? row.en : row.ms;
        const pos = Math.max(at !== -1 ? at : a2, 0);
        snippet = src.slice(Math.max(0, pos - 60), pos + 160).trim();
      }
      const [s, a] = row.key.split(":").map(Number);
      const surah = bySurah.get(s) || {};
      results.push({
        key: row.key,
        surah: s,
        ayah: a,
        name_en: surah.name_en || "",
        name_ar: surah.name_ar_short || "",
        text: row.text,
        consensus: row.consensus,
        translation: mode === "translation" ? snippet : row.en,
      });
    }
    return { query: q, results, mode };
  }

  async function apiRandom() {
    const surahs = await apiSurahs();
    const total = surahs.reduce((n, s) => n + s.ayahs, 0);
    let pick = Math.floor(Math.random() * total) + 1;
    for (const s of surahs) {
      if (pick <= s.ayahs) return { key: `${s.number}:${pick}` };
      pick -= s.ayahs;
    }
    return { key: "1:1" };
  }

  /* Live cross-check. Tanzil is the one source a browser cannot fetch, so it is
   * reported from the build: the same sha256 the build verified, and the letter
   * verdict stored for this verse. Marked `recorded` so the UI says so. */
  async function apiVerify(key) {
    const started = performance.now();
    const data = await apiVerse(key);
    const expected = letters(verseCore(data.verse.text_full));
    const stored = Object.fromEntries(data.sources.map((s) => [s.id, s]));

    async function live(id, name, url, read) {
      const t0 = performance.now();
      try {
        const res = await realFetch(url, { signal: AbortSignal.timeout(25000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = read(await res.json());
        if (!text) throw new Error("empty text in response");
        const same = letters(verseCore(text)) === expected;
        return { id, name, ok: same, letters_equal: same, text, ms: Math.round(performance.now() - t0), note: "single verse, fetched live" };
      } catch (err) {
        return { id, name, ok: false, error: `${err.name}: ${err.message}`, ms: Math.round(performance.now() - t0) };
      }
    }

    const jobs = [
      live("quran_com", "Quran.com", `https://api.quran.com/api/v4/verses/by_key/${key}?fields=text_uthmani`, (j) => j?.verse?.text_uthmani?.trim()),
      live("alquran_cloud", "Al Quran Cloud", `https://api.alquran.cloud/v1/ayah/${key}/quran-uthmani`, (j) => j?.data?.text?.trim()),
    ];
    const tanzil = stored.tanzil || {};
    const recorded = {
      id: "tanzil",
      name: "Tanzil Project",
      ok: !!tanzil.letters_equal,
      letters_equal: !!tanzil.letters_equal,
      text: tanzil.text || "",
      ms: 0,
      recorded: true,
      checksum_ok: true,
      note: "not re-fetched: tanzil.net sends no CORS header. Verdict and sha256 are the build's.",
    };
    const liveResults = await Promise.all(jobs);
    const ordered = [recorded, ...liveResults];
    const responding = liveResults.filter((r) => !r.error);
    const agreeing = responding.filter((r) => r.letters_equal);
    return {
      key,
      static: true,
      checked_at: new Date().toISOString(),
      seconds: Math.round((performance.now() - started) / 10) / 100,
      agreeing: agreeing.length + (recorded.letters_equal ? 1 : 0),
      responding: responding.length + 1, // Tanzil answered at build time
      total: liveResults.length + 1,
      sources: ordered,
    };
  }

  async function apiAudioConfig() {
    const cfg = await load("audio.json");
    return { ...cfg, downloaded: Object.fromEntries(cfg.editions.map((e) => [e.id, []])) };
  }

  async function apiAudioSurah(surah, edition) {
    const cfg = await load("audio.json");
    const ed = edition || cfg.default;
    if (!cfg.editions.some((e) => e.id === ed)) throw new Error(`unknown reciter ${ed}`);
    const payload = await load(surahPath(surah));
    const urls = {};
    for (const v of payload.verses) {
      urls[String(v.ayah)] = CDN.replace("{bitrate}", cfg.bitrate).replace("{edition}", ed).replace("{number}", v.n);
    }
    return {
      edition: ed,
      surah: Number(surah),
      ayahs: payload.verses.length,
      present: 0,
      missing: [],
      complete: false,
      bytes: 0,
      manifest: null,
      urls,
      job: null,
      // The CDN sends no Access-Control-Allow-Origin, so a browser cannot fetch
      // an MP3 into storage; the web edition streams only.
      stream_only: true,
    };
  }

  const routes = [
    [/^status$/, () => apiStatus()],
    [/^surahs$/, () => apiSurahs()],
    [/^surah\/(\d+)$/, (m) => apiSurah(m[1])],
    [/^verse\/(\d+):(\d+)$/, (m) => apiVerse(`${m[1]}:${m[2]}`)],
    [/^search$/, (m, q) => apiSearch(q.get("q"), Number(q.get("limit")) || 40)],
    [/^random$/, () => apiRandom()],
    [/^verify\/(\d+):(\d+)$/, (m) => apiVerify(`${m[1]}:${m[2]}`)],
    [/^audio\/config$/, () => apiAudioConfig()],
    [/^audio\/(\d+)$/, (m, q) => apiAudioSurah(m[1], q.get("edition"))],
    [/^audio\/(\d+)\/(status)$/, (m) => apiAudioSurah(m[1])],
  ];

  window.fetch = async (input, init = {}) => {
    const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const match = url.pathname.match(/\/api\/([^?]*)/);
    if (!match) return realFetch(input, init);
    const path = decodeURIComponent(match[1]).replace(/\/$/, "");
    try {
      for (const [pattern, handler] of routes) {
        const m = path.match(pattern);
        if (!m) continue;
        if (method !== "GET" && method !== "HEAD") {
          throw Object.assign(new Error("the web edition has no writable server"), { status: 405 });
        }
        const body = await handler(m, url.searchParams);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      throw Object.assign(new Error(`no static equivalent for /api/${path}`), { status: 404 });
    } catch (err) {
      return new Response(JSON.stringify({ detail: err.message }), {
        status: err.status || 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
  };
})();
