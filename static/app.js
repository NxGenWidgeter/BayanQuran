/* Tawatur — reader + verification inspector. No framework, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  surahs: [],
  surah: null,
  verses: [],
  selected: null,
  lang: "en",
  status: null,
  search: { q: "", results: [], mode: null, busy: false },
  marks: new Set(),          // verse keys bookmarked locally, bayan.marks
  marksOnly: false,          // sidebar showing the marked list instead of surahs
  suppressHash: false,
  audio: {
    config: null,
    edition: "ar.alafasy",
    surahState: null,
    urls: {},
    active: false,
    playing: false,
    ayah: 1,
    surah: null,
    jobTimer: null,
    downloaded: new Set(),
  },
};

const player = new Audio();
player.preload = "auto";

const TRANSLATORS = {
  en: "Saheeh International",
  ms: "Basmeih · Tafsir Pimpinan ar-Rahman",
};

/* ---------- tiny DOM helpers ---------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

let toastTimer = null;
function toast(message) {
  const box = $("#toast");
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/* ---------- theme & language ---------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store("bayan.theme", theme);
}

function initTheme() {
  const saved = store("bayan.theme");
  if (saved === "light" || saved === "dark") return applyTheme(saved);
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  applyTheme(prefersLight ? "light" : "dark");
}

/* ---------- Arabic text size ---------- */

/* Two knobs, one pair of buttons. The size is what the reader sets; the leading
   follows it, because larger type needs proportionally less air and smaller type
   more. Both land as CSS variables so the reader and the inspector stay in step. */
const VERSE_SIZE_MIN = 16;
const VERSE_SIZE_MAX = 44;
const VERSE_SIZE_STEP = 2;
const VERSE_SIZE_DEFAULT = 26;

function verseSize() {
  const n = Number(store("bayan.verseSize"));
  if (!Number.isFinite(n) || n <= 0) return VERSE_SIZE_DEFAULT;
  return Math.min(VERSE_SIZE_MAX, Math.max(VERSE_SIZE_MIN, Math.round(n)));
}

function applyVerseSize(px) {
  px = Math.min(VERSE_SIZE_MAX, Math.max(VERSE_SIZE_MIN, Math.round(px)));
  const lh = 2.05 + (VERSE_SIZE_DEFAULT - px) * 0.004;
  document.documentElement.style.setProperty("--verse-size", `${px}px`);
  document.documentElement.style.setProperty("--verse-lh", String(Math.round(lh * 1000) / 1000));
  store("bayan.verseSize", String(px));
  const minus = $("#verseMinus");
  const plus = $("#versePlus");
  // The buttons say what they will do next, and stop at the ends of the range.
  if (minus) {
    minus.disabled = px <= VERSE_SIZE_MIN;
    minus.title = `Smaller Arabic text (${px}px)`;
  }
  if (plus) {
    plus.disabled = px >= VERSE_SIZE_MAX;
    plus.title = `Larger Arabic text (${px}px)`;
  }
}

function initVerseSize() {
  applyVerseSize(verseSize());
  if ($("#verseMinus")) $("#verseMinus").onclick = () => applyVerseSize(verseSize() - VERSE_SIZE_STEP);
  if ($("#versePlus")) $("#versePlus").onclick = () => applyVerseSize(verseSize() + VERSE_SIZE_STEP);
}

/* ---------- reading preferences ---------- */

/* Five knobs, the same store() helper and the same shape as the size pair above:
   a reader that clamps a saved value, an apply that paints + persists, and one
   init that binds the panel. Reset sends every default back through apply, so
   there is exactly one path that touches the document. */

const TR_SIZE_MIN = 12;
const TR_SIZE_MAX = 20;
const TR_SIZE_DEFAULT = 12.5;

const ARABIC_FONTS = {
  amiri: "var(--arabic)",
  // No Naskh webfont ships in static/fonts, so this is whatever serif the
  // machine already has — never a download.
  serif: '"Noto Naskh Arabic", "Scheherazade New", Georgia, "Times New Roman", serif',
};

function trSize() {
  const n = Number(store("bayan.trSize"));
  if (!Number.isFinite(n) || n <= 0) return TR_SIZE_DEFAULT;
  return Math.min(TR_SIZE_MAX, Math.max(TR_SIZE_MIN, Math.round(n * 2) / 2));
}

function applyTrSize(px) {
  px = Math.min(TR_SIZE_MAX, Math.max(TR_SIZE_MIN, Math.round(px * 2) / 2));
  document.documentElement.style.setProperty("--tr-size", `${px}px`);
  store("bayan.trSize", String(px));
  const input = $("#trSize");
  const out = $("#trSizeVal");
  if (input) input.value = String(px);
  if (out) out.textContent = `${px} px`;
}

function arabicFont() {
  return store("bayan.arabicFont") === "serif" ? "serif" : "amiri";
}

function applyArabicFont(key) {
  if (!ARABIC_FONTS[key]) key = "amiri";
  document.documentElement.style.setProperty("--arabic-read", ARABIC_FONTS[key]);
  store("bayan.arabicFont", key);
  const select = $("#arabicFont");
  if (select) select.value = key;
}

function trVisible() {
  return store("bayan.tr") !== "hide";
}

function applyTrVisible(show) {
  // data-trans on <html>, not data-tr: data-tr belongs to the two segment
  // buttons, and an attribute on the root would match every closest() in the
  // page (it swallowed the other controls in this panel once already).
  document.documentElement.dataset.trans = show ? "show" : "hide";
  store("bayan.tr", show ? "show" : "hide");
  for (const btn of document.querySelectorAll("#readingPanel button[data-tr]")) {
    btn.classList.toggle("on", (btn.dataset.tr === "show") === show);
  }
}

const SURAH_SORTS = ["canonical", "name", "long", "short"];

function surahSort() {
  const saved = store("bayan.surahSort");
  return SURAH_SORTS.includes(saved) ? saved : "canonical";
}

function applySurahSort(mode) {
  if (!SURAH_SORTS.includes(mode)) mode = "canonical";
  store("bayan.surahSort", mode);
  const select = $("#surahSort");
  if (select) select.value = mode;
  // Sidebar only: the reader and the hash are untouched, and renderSurahs()
  // re-marks the current surah, so the selection survives the reorder.
  if (state.surahs.length) renderSurahs($("#surahFilter") ? $("#surahFilter").value : "");
}

function followOn() {
  return store("bayan.follow") === "on";
}

function applyFollow(on) {
  store("bayan.follow", on ? "on" : "off");
  for (const btn of document.querySelectorAll("#readingPanel button[data-follow]")) {
    btn.classList.toggle("on", (btn.dataset.follow === "on") === on);
  }
}

/* Verse starts are the only moment that may move the page, and a reader who
   scrolled or typed in the last moment owns the view instead. */
let lastUserScroll = 0;

function followScroll(node) {
  if (!node || !followOn()) return;
  if (Date.now() - lastUserScroll < 1500) return;
  const reader = $(".reader");
  if (!reader) return;
  const r = node.getBoundingClientRect();
  const box = reader.getBoundingClientRect();
  const pad = document.body.classList.contains("has-player") ? 96 : 24;
  if (r.top >= box.top + 8 && r.bottom <= box.bottom - pad) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const top = Math.max(0, reader.scrollTop + (r.top - box.top) - Math.max(8, (box.height - r.height) / 2));
  // "instant", not "auto": .reader sets scroll-behavior: smooth, and "auto"
  // would defer to it and animate anyway.
  reader.scrollTo({ top, behavior: reduce ? "instant" : "smooth" });
}

function openReading() {
  $("#readingPanel").hidden = false;
  $("#readingBtn").setAttribute("aria-expanded", "true");
}

function closeReading() {
  $("#readingPanel").hidden = true;
  $("#readingBtn").setAttribute("aria-expanded", "false");
}

function resetReading() {
  applyTrSize(TR_SIZE_DEFAULT);
  applyArabicFont("amiri");
  applyTrVisible(true);
  applyFollow(false);
  applySurahSort("canonical");
  toast("Reading settings reset");
}

function initReading() {
  applyTrSize(trSize());
  applyArabicFont(arabicFont());
  applyTrVisible(trVisible());
  applyFollow(followOn());
  // A saved sort is applied by the boot-time renderSurahs(); painting the
  // select now keeps the panel honest even before the corpus arrives.
  const sortSelect = $("#surahSort");
  if (sortSelect) sortSelect.value = surahSort();

  const btn = $("#readingBtn");
  btn.onclick = () => ($("#readingPanel").hidden ? openReading() : closeReading());
  $("#readingClose").onclick = closeReading;
  $("#readingPanel").addEventListener("click", (e) => {
    // button[data-…], never a bare [data-…]: a data attribute on <html> would
    // match closest() from anywhere in the document.
    const trBtn = e.target.closest("button[data-tr]");
    if (trBtn) return applyTrVisible(trBtn.dataset.tr === "show");
    const followBtn = e.target.closest("button[data-follow]");
    if (followBtn) return applyFollow(followBtn.dataset.follow === "on");
  });
  $("#trSize").addEventListener("input", (e) => applyTrSize(Number(e.target.value)));
  $("#arabicFont").addEventListener("change", (e) => applyArabicFont(e.target.value));
  $("#surahSort").addEventListener("change", (e) => applySurahSort(e.target.value));
  $("#readingReset").onclick = resetReading;

  document.addEventListener("click", (e) => {
    if ($("#readingPanel").hidden) return;
    if (e.target.closest("#readingWrap")) return;
    closeReading();
  });

  const reader = $(".reader");
  for (const ev of ["wheel", "touchstart", "keydown"]) {
    reader.addEventListener(ev, () => (lastUserScroll = Date.now()), { passive: true });
  }
}

function ensureVisible(node) {
  if (!node) return;
  const reader = $(".reader");
  const r = node.getBoundingClientRect();
  const box = reader.getBoundingClientRect();
  if (r.top < box.top + 8 || r.bottom > box.bottom - 8) {
    node.scrollIntoView({ block: "center" });
  }
}

function setLang(lang) {
  state.lang = lang;
  store("bayan.lang", lang);
  for (const btn of document.querySelectorAll("#langSeg button")) {
    btn.classList.toggle("on", btn.dataset.lang === lang);
  }
  if (state.search.q) runSearch(state.search.q);
  else {
    renderVerses();
    ensureVisible(document.querySelector(`.verse[data-key="${state.selected}"]`));
  }
  if (state.selected) selectVerse(state.selected, { keepHash: true });
}

/* ---------- consensus ---------- */

function consensusDots(n) {
  const wrap = el("span", { class: "cons", title: `${n} of 3 sources agree on the letters` });
  for (let i = 0; i < 3; i++) {
    wrap.append(el("i", { class: i < n ? "on" : "miss" }));
  }
  return wrap;
}

/* ---------- surah list ---------- */

/* On a phone the list is a drawer (style.css, <=900px). */
function openDrawer() {
  $(".sidebar").classList.add("open");
  $("#menuBtn").setAttribute("aria-expanded", "true");
}

function closeDrawer() {
  $(".sidebar").classList.remove("open");
  $("#menuBtn").setAttribute("aria-expanded", "false");
}

/* ---------- bookmarks ---------- */

/* One JSON array in localStorage, no server. A mark is just the verse key, so it
   survives a corpus rebuild as long as the reference still exists. */
function readMarks() {
  try {
    const raw = JSON.parse(store("bayan.marks") || "[]");
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((k) => typeof k === "string" && /^\d{1,3}:\d{1,3}$/.test(k)));
  } catch {
    return new Set();  // a corrupted value costs the marks, never the reader
  }
}

function writeMarks() {
  store("bayan.marks", JSON.stringify([...state.marks]));
}

function paintMarks() {
  for (const btn of document.querySelectorAll(".verse-mark")) {
    const on = state.marks.has(btn.dataset.key);
    btn.textContent = on ? "★" : "☆";
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? `Remove bookmark ${btn.dataset.key}` : `Bookmark ${btn.dataset.key}`;
  }
  const count = $("#marksCount");
  if (count) count.textContent = state.marks.size ? String(state.marks.size) : "";
}

function toggleMark(key) {
  if (state.marks.has(key)) state.marks.delete(key);
  else state.marks.add(key);
  writeMarks();
  paintMarks();
  if (state.marksOnly) renderSurahs($("#surahFilter").value);
  toast(state.marks.has(key) ? `Marked ${key}` : `Removed ${key}`);
}

function initMarks() {
  state.marks = readMarks();
  paintMarks();
  const btn = $("#marksBtn");
  if (!btn) return;
  btn.onclick = () => {
    state.marksOnly = !state.marksOnly;
    btn.classList.toggle("on", state.marksOnly);
    btn.setAttribute("aria-pressed", state.marksOnly ? "true" : "false");
    renderSurahs($("#surahFilter").value);
  };
}

/* The marked list replaces the surah list rather than filtering it: a bookmark
   is a verse, and a surah row would only say which chapter it is in. */
function renderMarked(list, filter = "") {
  const needle = filter.trim().toLowerCase();
  const keys = [...state.marks].sort((a, b) => {
    const [as, aa] = a.split(":").map(Number);
    const [bs, ba] = b.split(":").map(Number);
    return as - bs || aa - ba;
  });
  let shown = 0;
  for (const key of keys) {
    const [number, ayah] = key.split(":").map(Number);
    const s = state.surahs.find((x) => x.number === number);
    const hay = `${key} ${s ? s.name_en : ""} ${s ? s.meaning : ""}`.toLowerCase();
    if (needle && !hay.includes(needle)) continue;
    shown++;
    const open = () => {
      loadSurah(number, ayah);
      closeDrawer();
    };
    list.append(el("div", {
      class: "surah-row mark-row" + (state.surah === number ? " on" : ""),
      dataset: { key },
      role: "button",
      tabindex: "0",
      onclick: open,
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      },
    }, [
      el("span", { class: "surah-num mark-num", text: key }),
      el("div", {}, [
        el("div", { class: "surah-names" }, [
          el("span", { class: "surah-en", text: s ? s.name_en : `Surah ${number}` }),
        ]),
        el("div", { class: "surah-sub", text: s ? `${s.meaning} · ${s.revelation}` : "" }),
      ]),
    ]));
  }
  if (!shown) {
    list.append(el("div", {
      class: "side-empty",
      text: state.marks.size ? "No bookmark matches that filter." : "No bookmarks yet — tap ☆ on any verse.",
    }));
  }
  $("#surahCount").textContent = needle ? `${shown}/${state.marks.size}` : String(state.marks.size);
}

function renderSurahs(filter = "") {
  const list = $("#surahList");
  const needle = filter.trim().toLowerCase();
  list.replaceChildren();
  if (state.marksOnly) {
    renderMarked(list, filter);
    return;
  }
  let shown = 0;
  // Order is a reading preference; it re-sorts the sidebar only, never state.surahs.
  const rows = [...state.surahs];
  const order = surahSort();
  if (order === "name") rows.sort((a, b) => a.name_en.localeCompare(b.name_en));
  else if (order === "long") rows.sort((a, b) => b.ayahs - a.ayahs || a.number - b.number);
  else if (order === "short") rows.sort((a, b) => a.ayahs - b.ayahs || a.number - b.number);
  for (const s of rows) {
    const hay = `${s.number} ${s.name_en} ${s.name_ar_short} ${s.meaning}`.toLowerCase();
    if (needle && !hay.includes(needle)) continue;
    shown++;
    const row = el("div", {
      class: "surah-row" + (state.surah === s.number ? " on" : ""),
      dataset: { n: s.number },
      role: "button",
      tabindex: "0",
      onclick: () => {
        loadSurah(s.number);
        closeDrawer();
      },
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          loadSurah(s.number);
          closeDrawer();
        }
      },
    }, [
      el("span", { class: "surah-num", text: s.number }),
      el("div", {}, [
        el("div", { class: "surah-names" }, [
          el("span", { class: "surah-en", text: s.name_en }),
          el("span", { class: "surah-ar", text: s.name_ar_short, lang: "ar" }),
        ]),
        el("div", { class: "surah-sub" }, [
          `${s.ayahs} verses · ${s.revelation}`,
          state.audio.downloaded.has(s.number) ? el("span", { class: "surah-dl", text: "♪", title: "recitation downloaded" }) : null,
        ]),
      ]),
    ]);
    list.append(row);
  }
  $("#surahCount").textContent = needle ? `${shown}/114` : "114";
}

/* ---------- reader ---------- */

function surahHeading(s) {
  return el("div", { class: "surah-head" }, [
    el("div", { class: "eyebrow", text: `Surah ${s.number}` }),
    el("h2", {}, [
      el("span", { text: s.name_en }),
      el("span", { class: "ar", text: s.name_ar, lang: "ar" }),
    ]),
    el("div", { class: "surah-tags" }, [
      el("span", { class: "tag", text: s.meaning }),
      el("span", { class: "tag", text: `${s.ayahs} verses` }),
      el("span", { class: "tag", text: s.revelation }),
    ]),
    el("div", { class: "surah-actions", id: "surahActions" }),
  ]);
}

function verseCard(v) {
  const tr = v.translations[state.lang] || v.translations.en || "";
  const card = el("article", {
    class: "verse" + (state.selected === v.key ? " sel" : ""),
    dataset: { key: v.key },
    tabindex: "0",
    onclick: () => selectVerse(v.key),
    onkeydown: (e) => {
      if (e.key === "Enter") selectVerse(v.key);
    },
  }, [
    el("div", { class: "verse-top" }, [
      el("span", { class: "ref", text: v.key }),
      el("button", {
        class: "verse-play",
        text: "▶",
        title: "Recite from this verse",
        "aria-label": `Recite from verse ${v.key}`,
        onclick: (e) => {
          e.stopPropagation();
          startListening(v.ayah);
        },
      }),
      el("span", { class: "spacer" }),
      el("button", {
        class: "verse-mark" + (state.marks.has(v.key) ? " on" : ""),
        dataset: { key: v.key },
        text: state.marks.has(v.key) ? "★" : "☆",
        title: state.marks.has(v.key) ? `Remove bookmark ${v.key}` : `Bookmark ${v.key}`,
        "aria-label": `Bookmark verse ${v.key}`,
        "aria-pressed": state.marks.has(v.key) ? "true" : "false",
        onclick: (e) => {
          e.stopPropagation();
          toggleMark(v.key);
        },
      }),
      consensusDots(v.consensus),
    ]),
    el("div", { class: "verse-ar", text: v.text, lang: "ar", dir: "rtl" }),
    tr ? el("div", { class: "verse-tr", text: tr }) : null,
  ]);
  return card;
}

function renderVerses() {
  const inner = $("#readerInner");
  inner.replaceChildren();
  if (!state.surah) {
    inner.append(el("div", { class: "empty", text: "Pick a surah on the left." }));
    return;
  }
  const s = state.surahs.find((x) => x.number === state.surah);
  inner.append(surahHeading(s));
  if (s.number !== 1 && s.number !== 9) {
    inner.append(el("div", {
      class: "bismillah",
      lang: "ar",
      dir: "rtl",
      text: "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ",
    }));
  }
  for (const v of state.verses) inner.append(verseCard(v));
  if (state.audio.active && state.audio.surah === state.surah) markPlaying(state.audio.ayah, false);
}

let surahToken = 0;
let verseToken = 0;

async function loadSurah(number, ayah = null) {
  if (state.surah === number && state.verses.length && !state.search.q) {
    if (ayah) selectVerse(`${number}:${ayah}`);
    return;
  }
  state.search = { q: "", results: [], mode: null, busy: false };
  $("#q").value = "";
  const token = ++surahToken;
  const data = await api(`/api/surah/${number}`);
  if (token !== surahToken) return; // a newer surah load won
  if (state.audio.surah && state.audio.surah !== number && !state.audio.advancing) stopPlayback(true);
  state.surah = number;
  state.verses = data.verses;
  state.selected = null;
  $("#inspector").hidden = true;
  $("#workspace").classList.remove("with-inspector");
  renderSurahs($("#surahFilter").value);
  renderVerses();
  store("bayan.surah", String(number));
  setHash(String(number));
  $(".reader").scrollTop = 0;
  reloadAudioForSurah();
  if (ayah) selectVerse(`${number}:${ayah}`);
}

/* ---------- search ---------- */

let searchTimer = null;
function onSearchInput(value) {
  clearTimeout(searchTimer);
  const q = value.trim();
  if (/^\d{1,3}\s*[:.\s]\s*\d{1,3}$/.test(q)) {
    const [s, a] = q.split(/[:.\s]+/).map(Number);
    jumpTo(s, a);
    return;
  }
  if (q.length < 2) {
    if (state.search.q) {
      state.search.q = "";
      renderVerses();
    }
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 220);
}

async function runSearch(q) {
  state.search.q = q;
  state.search.busy = true;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    state.search.results = data.results;
    state.search.mode = data.mode;
    renderResults();
  } catch (err) {
    toast("Search failed: " + err.message);
  } finally {
    state.search.busy = false;
  }
}

function renderResults() {
  const inner = $("#readerInner");
  inner.replaceChildren();
  const { results, mode, q } = state.search;
  inner.append(el("div", { class: "results-head" }, [
    el("h2", { text: `“${q}”` }),
    el("span", { text: `${results.length} verse${results.length === 1 ? "" : "s"} · ${mode === "arabic" ? "Arabic letters" : "translation text"}` }),
  ]));
  if (!results.length) {
    inner.append(el("div", { class: "empty", text: "No verse matched. Arabic search ignores diacritics, so try bare letters." }));
    return;
  }
  for (const r of results) {
    inner.append(el("article", {
      class: "result",
      tabindex: "0",
      onclick: () => openFromSearch(r.key),
      onkeydown: (e) => {
        if (e.key === "Enter") openFromSearch(r.key);
      },
    }, [
      el("div", { class: "r-top" }, [
        el("span", { class: "ref", text: r.key }),
        el("span", { text: `${r.name_en}` }),
        el("span", { class: "spacer" }),
        consensusDots(r.consensus),
      ]),
      el("div", { class: "r-ar", text: r.text, lang: "ar", dir: "rtl" }),
      r.translation ? el("div", { class: "r-tr", text: r.translation }) : null,
    ]));
  }
}

async function openFromSearch(key) {
  const [s, a] = key.split(":").map(Number);
  $("#q").value = "";
  state.search = { q: "", results: [], mode: null, busy: false };
  await loadSurah(s);
  selectVerse(key);
  const node = document.querySelector(`.verse[data-key="${key}"]`);
  if (node) node.scrollIntoView({ block: "center" });
}

async function jumpTo(surah, ayah) {
  if (surah < 1 || surah > 114) return toast("Surah must be 1–114");
  await loadSurah(surah, ayah);
  const node = document.querySelector(`.verse[data-key="${surah}:${ayah}"]`);
  if (node) node.scrollIntoView({ block: "center" });
}

/* ---------- inspector ---------- */

function highlight(text, needles) {
  const frag = document.createDocumentFragment();
  let rest = text;
  for (const needle of needles.filter(Boolean)) {
    const idx = rest.indexOf(needle);
    if (idx === -1) continue;
    if (idx > 0) frag.append(document.createTextNode(rest.slice(0, idx)));
    frag.append(el("mark", { text: needle }));
    rest = rest.slice(idx + needle.length);
  }
  if (rest) frag.append(document.createTextNode(rest));
  return frag;
}

function sourceRow(src) {
  const status = src.letters_equal
    ? (src.exact ? "identical" : "same letters")
    : "differs";
  const needles = src.letters_equal ? [] : src.diff.map((d) => d.candidate);
  const row = el("div", { class: "src", dataset: { id: src.id } }, [
    el("div", { class: "src-head" }, [
      el("span", { class: "dot " + (src.letters_equal ? "ok" : "warn") }),
      el("span", { class: "nm", text: src.name }),
      el("span", { class: "ed", text: src.edition }),
      el("span", { class: "st" + (src.letters_equal ? "" : " bad"), text: status }),
      el("button", {
        class: "src-toggle",
        title: "Show this edition's text",
        "aria-label": "Show this edition's text",
        text: "▾",
        onclick: (e) => {
          e.stopPropagation();
          row.classList.toggle("open");
        },
      }),
    ]),
    el("div", {
      class: "src-text",
      lang: "ar",
      dir: "rtl",
    }, [highlight(src.text, needles)]),
  ]);
  return row;
}

function verificationPanel(data) {
  const v = data.verse;
  const n = v.consensus;
  const sources = data.sources;
  const panel = el("div", { class: "panel" }, [
    el("div", { class: "panel-head" }, [
      el("span", { class: "t", text: "Verification" }),
      el("span", {
        class: "badge " + (n === 3 ? "good" : "warn"),
        text: n === 3 ? "3 of 3 agree" : `${n} of 3 agree`,
      }),
    ]),
  ]);
  for (const src of sources) panel.append(sourceRow(src));

  if (v.variants.length) {
    const differing = sources.filter((s) => !s.letters_equal);
    for (const src of differing) {
      for (const d of src.diff) {
        panel.append(el("div", { class: "diff-note" }, [
          el("strong", { text: src.name + " " }),
          el("span", { text: `writes “${d.candidate}” where the other editions write “${d.canonical}”. ` }),
          el("span", { text: "The canonical text keeps the reading the two other sources confirm." }),
        ]));
      }
    }
  }

  panel.append(el("div", { class: "src-note" }, [
    el("span", { text: "Compared on the consonantal text: diacritics, tatweel and hamza placement are allowed to differ." }),
  ]));
  return panel;
}

function liveBox() {
  return el("div", { class: "live-out", id: "liveOut", hidden: true });
}

async function renderInspector(data) {
  const inner = $("#inspInner");
  const v = data.verse;
  const s = data.surah;
  const tr = v.translations[state.lang] || v.translations.en || "";
  inner.replaceChildren();

  inner.append(el("div", { class: "insp-bar" }, [
    el("span", { class: "label", text: "Selected verse" }),
    el("span", {
      class: "badge inline " + (v.consensus === 3 ? "good" : "warn"),
      text: v.consensus === 3 ? "3 of 3 agree" : `${v.consensus} of 3 agree`,
      title: "How many of the three published editions agree on the letters",
    }),
    el("span", { class: "spacer" }),
    el("div", { class: "insp-nav" }, [
      el("button", {
        text: "‹",
        title: "Previous verse",
        disabled: !data.prev,
        onclick: () => data.prev && selectVerse(data.prev),
      }),
      el("button", {
        text: "›",
        title: "Next verse",
        disabled: !data.next,
        onclick: () => data.next && selectVerse(data.next),
      }),
      el("button", {
        text: "✕",
        title: "Close",
        onclick: closeInspector,
      }),
    ]),
  ]));

  const body = el("div", { class: "insp-body" }, [
    el("div", { class: "insp-ref", text: `${s.name_en} · ${v.key}` }),
    el("div", { class: "insp-ar", text: v.text, lang: "ar", dir: "rtl" }),
    el("div", { class: "insp-tr" }, [
      document.createTextNode(tr || "No translation for this language."),
      el("span", { class: "who", text: TRANSLATORS[state.lang] }),
    ]),
    verificationPanel(data),
    el("div", { class: "insp-actions" }, [
      el("button", { class: "btn primary", text: "Re-check live", onclick: (e) => liveCheck(v.key, e.currentTarget) }),
      el("button", { class: "btn", text: "Copy verse", onclick: () => copyVerse(v, s) }),
      el("a", {
        class: "btn",
        href: `https://quran.com/${v.surah}/${v.ayah}`,
        target: "_blank",
        rel: "noopener noreferrer",
        text: "Open on Quran.com ↗",
      }),
    ]),
    liveBox(),
  ]);
  inner.append(body);
}

async function selectVerse(key, opts = {}) {
  const token = ++verseToken;
  state.selected = key;
  for (const card of document.querySelectorAll(".verse")) {
    card.classList.toggle("sel", card.dataset.key === key);
  }
  $("#inspector").hidden = false;
  $("#workspace").classList.add("with-inspector");
  if (!opts.keepHash) setHash(key);
  try {
    const data = await api(`/api/verse/${key}`);
    if (token !== verseToken) return; // a newer selection won; do not paint stale facts
    await renderInspector(data);
    store("bayan.verse", key);
  } catch (err) {
    toast("Could not load verse: " + err.message);
  }
}

function closeInspector() {
  $("#inspector").hidden = true;
  $("#workspace").classList.remove("with-inspector");
  state.selected = null;
  for (const card of document.querySelectorAll(".verse")) card.classList.remove("sel");
  if (state.surah) setHash(String(state.surah));
}

async function liveCheck(key, button) {
  const out = $("#liveOut");
  button.disabled = true;
  button.textContent = "Checking…";
  out.hidden = false;
  out.replaceChildren(el("span", { text: window.BAYAN_STATIC
    ? "Contacting Quran.com and Al Quran Cloud… Tanzil cannot be re-downloaded by a browser, so its build-time verdict is shown instead."
    : "Contacting Tanzil, Quran.com and Al Quran Cloud… Tanzil re-downloads its whole 1.3 MB text file, so this can take up to a minute." }));
  try {
    const res = await api(`/api/verify/${key}`);
    out.replaceChildren();
    const lines = [];
    for (const src of res.sources) {
      if (src.error) {
        lines.push(el("div", {}, [el("span", { class: "err", text: "✕ " }), `${src.name}: ${src.error}`]));
        continue;
      }
      if (src.recorded) {
        lines.push(el("div", {}, [
          el("span", { class: src.letters_equal ? "ok" : "bad", text: src.letters_equal ? "• " : "! " }),
          `${src.name}: ${src.letters_equal ? "agrees" : "differs"} · checked at build time`,
          src.checksum_ok === true ? el("span", { class: "ok", text: " · sha256 verified" }) : null,
          el("span", { style: "color:var(--faint)", text: src.note ? ` — ${src.note}` : "" }),
        ]));
        continue;
      }
      const good = src.letters_equal;
      lines.push(el("div", {}, [
        el("span", { class: good ? "ok" : "bad", text: good ? "✓ " : "! " }),
        `${src.name}: ${good ? "agrees" : "differs"} · ${src.ms} ms`,
        src.checksum_ok === false ? el("span", { class: "bad", text: " · checksum mismatch" }) : null,
        src.checksum_ok === true ? el("span", { class: "ok", text: " · sha256 verified" }) : null,
      ]));
    }
    out.append(
      el("div", { style: "margin-bottom:6px;color:var(--text)" },
        [`Checked just now in ${res.seconds}s — ${res.agreeing} of ${res.total} sources agree` +
         (res.responding < res.total ? ` (${res.total - res.responding} unreachable)` : "")]),
      ...lines,
      el("div", { style: "margin-top:6px;color:var(--faint)" },
        [window.BAYAN_STATIC
          ? "The two APIs were fetched live just now; Tanzil's line is the build-time check, since tanzil.net sends no CORS header."
          : "Cached corpus is not consulted for the verdict; the texts above were fetched live."]),
    );
    out.scrollIntoView({ block: "nearest" });
  } catch (err) {
    out.replaceChildren(el("span", { class: "err", text: "Live check failed: " + err.message }));
  } finally {
    button.disabled = false;
    button.textContent = "Re-check live";
  }
}

async function copyVerse(v, s) {
  const tr = v.translations[state.lang] || v.translations.en || "";
  const text = `${v.text}\n\n${tr}\n— Quran ${v.key} (${s.name_en}), ${TRANSLATORS[state.lang]}`;
  try {
    await navigator.clipboard.writeText(text);
    toast("Verse copied");
  } catch {
    const area = el("textarea", { style: "position:fixed;opacity:0" });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    toast("Verse copied");
  }
}

/* ---------- status modal ---------- */

function renderStatus() {
  const body = $("#statusBody");
  const st = state.status;
  if (!st) return;
  body.replaceChildren();

  body.append(el("p", { text:
    "Every verse here is cross-checked at build time against three separately published Uthmani editions, and you can re-run the check live from any verse. Agreement is judged on the consonantal text: the letters must match exactly, while diacritics, tatweel, hamza placement and word spacing are allowed to differ between publishers." }));

  const t = st.totals;
  body.append(el("h3", { text: "Corpus" }));
  body.append(el("div", { class: "checks" }, [
    el("div", { class: "check" }, [el("span", { class: "tick", text: "✓" }),
      el("span", {}, [el("strong", { text: `${t.three_of_three.toLocaleString()} of ${t.verses.toLocaleString()} verses ` }),
        el("span", { class: "detail", text: "agree across all three sources" })])]),
    el("div", { class: "check" }, [el("span", { class: "tick", text: "•" }),
      el("span", {}, [el("span", { text: `${t.two_of_three} verse${t.two_of_three === 1 ? "" : "s"} ` }),
        el("span", { class: "detail", text: "agree in two of three — listed below with the differing word" })])]),
    el("div", { class: "check" }, [el("span", { class: "tick", text: "•" }),
      el("span", {}, [el("span", { class: "detail", text: `${t.below_two} verses are contradicted by both cross-check sources` })])]),
  ]));

  body.append(el("h3", { text: "Sources" }));
  const table = el("table", { class: "src-table" });
  for (const src of st.sources) {
    table.append(el("tr", {}, [
      el("td", {}, [el("a", { href: src.url, target: "_blank", rel: "noopener noreferrer", text: src.name })]),
      el("td", { text: src.edition }),
      el("td", { text: src.role === "canonical" ? "canonical text" : "cross-check" }),
    ]));
  }
  body.append(table);

  body.append(el("h3", { text: window.BAYAN_STATIC
    ? "Integrity checks (verified when this edition was published)"
    : "Integrity checks (run against the database now)" }));
  const checks = el("div", { class: "checks" });
  for (const c of st.checks) {
    checks.append(el("div", { class: "check" + (c.ok ? "" : " fail") }, [
      el("span", { class: "tick", text: c.ok ? "✓" : "✕" }),
      el("span", {}, [el("span", { text: c.name + " " }), el("span", { class: "detail", text: "— " + c.detail })]),
    ]));
  }
  body.append(checks);

  if (Object.keys(st.variants).length) {
    const nameOf = Object.fromEntries(st.sources.map((s) => [s.id, s.name]));
    body.append(el("h3", { text: "Where the editions differ" }));
    for (const [key, info] of Object.entries(st.variants)) {
      const diff = info.diff?.[0];
      const row = el("div", { class: "variant-row" }, [
        el("button", { text: key, onclick: () => { $("#statusModal").hidden = true; jumpTo(...key.split(":").map(Number)); } }),
        el("span", { class: "detail", text: diff
          ? `${info.disagrees_with.map((id) => nameOf[id] || id).join(", ")} writes “${diff.candidate}” — the others write “${diff.canonical}”`
          : info.disagrees_with.map((id) => nameOf[id] || id).join(", ") }),
      ]);
      body.append(row);
    }
  }

  body.append(el("h3", { text: "Provenance" }));
  body.append(el("div", { class: "mono", text: `Tanzil Uthmani 1.1 sha256 ${st.tanzil_sha256}` }));
  body.append(el("div", { class: "mono", text: `corpus sha256 ${st.corpus_sha256}` }));
  body.append(el("div", { class: "check" }, [el("span", { class: "detail", text: `Built ${st.built_at}` })]));

  body.append(el("div", { class: "disclaimer" }, [
    document.createTextNode(
      "Arabic text is reproduced unmodified from the Tanzil Project (uthmani, version 1.1), used under its terms: verbatim copying only, source credited, link to tanzil.net retained. Translations are interpretations, not the Quran itself, and are shown with their translator's name. "
    ),
    el("a", { href: "https://tanzil.net/docs/Text_License", target: "_blank", rel: "noopener noreferrer", text: "Tanzil text licence" }),
    document.createTextNode(" · "),
    el("a", { href: "https://quran.com", target: "_blank", rel: "noopener noreferrer", text: "Quran.com" }),
    document.createTextNode(" · "),
    el("a", { href: "https://alquran.cloud", target: "_blank", rel: "noopener noreferrer", text: "Al Quran Cloud" }),
  ]));
  body.append(el("div", { class: "disclaimer" }, [
    document.createTextNode(
      "Tawatur is free to use: no account, no payment, no ads, and no tracking of any kind. This published edition needs nothing installed; the desktop edition runs on your own machine and never sends your reading anywhere."
    ),
  ]));
}

/* ---------- recitation + transcript ---------- */

const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtTime = (t) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}` : "0:00");

async function initAudio() {
  const cfg = await api("/api/audio/config");
  state.audio.config = cfg;
  const saved = store("bayan.reciter");
  state.audio.edition = cfg.editions.some((e) => e.id === saved) ? saved : cfg.default;

  const sel = $("#pEdition");
  sel.replaceChildren(...cfg.editions.map((e) => el("option", { value: e.id, text: e.name })));
  sel.value = state.audio.edition;
  state.audio.downloaded = new Set(cfg.downloaded[state.audio.edition] || []);
  refreshDownloaded();
  sel.onchange = () => {
    state.audio.edition = sel.value;
    store("bayan.reciter", sel.value);
    reloadAudioForSurah(true);
  };

  player.addEventListener("ended", () => nextAyah(true));
  player.addEventListener("timeupdate", updateProgress);
  player.addEventListener("loadedmetadata", updateProgress);
  player.addEventListener("play", () => {
    state.audio.playing = true;
    if (!state.audio.fading) player.volume = 1;   // never resume stuck quiet
    paintPlay();
  });
  player.addEventListener("pause", () => { state.audio.playing = false; paintPlay(); });
  player.addEventListener("error", () => {
    if (!state.audio.active) return;
    $("#pState").textContent = "audio unavailable — try another reciter";
  });

  $("#pPlay").onclick = togglePlay;
  $("#pPrev").onclick = () => state.audio.ayah > 1 && playAyah(state.audio.ayah - 1);
  $("#pNext").onclick = () => nextAyah(false);
  $("#pClose").onclick = () => stopPlayback();
}

async function refreshDownloaded() {
  try {
    const cfg = await api("/api/audio/config");
    state.audio.downloaded = new Set(cfg.downloaded[state.audio.edition] || []);
    if (state.surahs.length) renderSurahs($("#surahFilter").value);
  } catch {
    /* a stale marker is harmless */
  }
}

async function reloadAudioForSurah(keepPlaying = false) {
  if (!state.surah) return;
  try {
    const data = await api(`/api/audio/${state.surah}?edition=${state.audio.edition}`);
    state.audio.surahState = data;
    state.audio.urls = data.urls;
    renderSurahActions();
    if (keepPlaying && state.audio.active && state.audio.surah === state.surah) {
      playAyah(state.audio.ayah, true);
    }
  } catch (err) {
    toast("Could not read audio state: " + err.message);
  }
}

function renderSurahActions() {
  const box = $("#surahActions");
  if (!box) return;
  const st = state.audio.surahState;
  box.replaceChildren(
    el("button", {
      class: "audio-btn",
      title: "Recite this surah with the verses as a transcript",
      onclick: () => startListening(),
    }, [el("span", { class: "glyph", text: "▶" }), "Listen"]),
    el("button", {
      class: "audio-btn small",
      title: "Save this surah's verses as a text transcript",
      onclick: () => downloadTranscript(),
    }, ["Transcript"]),
  );
  if (!st) return;
  const per = state.audio.config?.bytes_per_ayah || 65536;

  if (st.stream_only) {
    box.append(el("span", { class: "audio-hint", text: "streams from the CDN · offline downloads need the desktop app" }));
    return;
  }

  if (st.job && ["running", "queued"].includes(st.job.state)) {
    const pct = st.job.total ? Math.round((100 * st.job.done) / st.job.total) : 0;
    box.append(el("span", { class: "audio-btn small", text: `Downloading ${st.job.done}/${st.job.total} · ${pct}%` }));
    startJobPolling();
    return;
  }
  if (st.complete) {
    box.append(el("button", {
      class: "audio-btn small",
      title: "Delete the downloaded files for this surah",
      onclick: () => removeAudio(),
    }, [el("span", { class: "glyph", text: "✓" }), `Downloaded · ${fmtBytes(st.bytes)}`]));
    box.append(el("span", { class: "audio-hint", text: "plays offline" }));
    return;
  }
  if (st.job && st.job.state === "error") {
    box.append(el("button", { class: "audio-btn small", onclick: () => startDownload(), title: st.job.error },
      ["Download failed — retry"]));
    return;
  }
  box.append(el("button", {
    class: "audio-btn small",
    title: "Download every verse of this surah so it plays offline",
    onclick: () => startDownload(),
  }, [el("span", { class: "glyph", text: "↓" }), `Download · ~${fmtBytes(st.ayahs * per)}`]));
  if (st.present) box.append(el("span", { class: "audio-hint", text: `${st.present}/${st.ayahs} on disk` }));
}

async function startDownload() {
  try {
    await api(`/api/audio/${state.surah}/download?edition=${state.audio.edition}`, { method: "POST" });
    await reloadAudioForSurah();
    startJobPolling();
  } catch (err) {
    toast("Download failed: " + err.message);
  }
}

function startJobPolling() {
  if (state.audio.jobTimer) return;
  const surah = state.surah;
  state.audio.jobTimer = setInterval(async () => {
    if (state.surah !== surah) {
      clearInterval(state.audio.jobTimer);
      state.audio.jobTimer = null;
      return;
    }
    try {
      const st = await api(`/api/audio/${surah}/status?edition=${state.audio.edition}`);
      state.audio.surahState = st;
      renderSurahActions();
      if (["done", "error"].includes(st.state)) {
        clearInterval(state.audio.jobTimer);
        state.audio.jobTimer = null;
        if (st.state === "done") {
          await reloadAudioForSurah();
          await refreshDownloaded();
          toast(`Audio saved — ${st.ayahs} verses play offline`);
        } else {
          toast("Download failed: " + (st.error || "unknown error"));
        }
      }
    } catch {
      clearInterval(state.audio.jobTimer);
      state.audio.jobTimer = null;
    }
  }, 700);
}

async function removeAudio() {
  if (!confirm("Delete the downloaded recitation for this surah?")) return;
  await api(`/api/audio/${state.surah}?edition=${state.audio.edition}`, { method: "DELETE" });
  await reloadAudioForSurah();
  await refreshDownloaded();
  toast("Downloaded audio removed");
}

function openPlayer() {
  state.audio.active = true;
  $("#player").hidden = false;
  document.body.classList.add("has-player");
  $("#pReciter").textContent = state.audio.config?.editions.find((e) => e.id === state.audio.edition)?.name || "";
}

/* Continuous recitation. When a surah's last verse ends, the next surah starts
   on its own: the final verse fades down as it approaches its end, then the
   first verse of the next surah fades up. No cut, no dead air, no stopping at
   2am. Wraps from 114 back to 1 so an overnight listen never runs dry. */
const FADE_IN_MS = 1600;
const FADE_OUT_S = 1.6;
let fadeTimer = null;
let fadeOutArmed = -1;      // verse number whose fade-down already started

function stopFade() {
  if (fadeTimer) {
    clearInterval(fadeTimer);
    fadeTimer = null;
  }
  state.audio.fading = false;
}

function fadeTo(target, ms, done) {
  stopFade();
  state.audio.fading = true;
  const from = player.volume;
  const start = performance.now();
  fadeTimer = setInterval(() => {
    const t = Math.min(1, (performance.now() - start) / Math.max(1, ms));
    player.volume = Math.max(0, Math.min(1, from + (target - from) * t));
    if (t >= 1) {
      stopFade();
      if (done) done();
    }
  }, 40);
}

function startListening(ayah) {
  openPlayer();
  const from = ayah || (state.selected && Number(state.selected.split(":")[1])) || 1;
  playAyah(from);
}

function playAyah(n, resume = false, fadeIn = false) {
  if (!state.surah) return;
  const url = state.audio.urls[String(n)];
  if (!url) {
    toast("No recitation for this verse");
    return;
  }
  state.audio.ayah = n;
  state.audio.surah = state.surah;
  openPlayer();
  const local = url.startsWith("/audio/");
  stopFade();
  fadeOutArmed = -1;
  if (fadeIn) {
    // guard the `play` handler: it snaps volume back to 1 unless a fade is live
    state.audio.fading = true;
    player.volume = 0;
  } else {
    player.volume = 1;
  }
  player.src = url;
  if (!resume) player.currentTime = 0;
  $("#pState").textContent = local ? "playing from download" : "streaming";
  const surah = state.surahs.find((x) => x.number === state.surah);
  $("#pRef").textContent = `${state.surah}:${n}`;
  $("#pSurah").textContent = surah ? surah.name_en : "";
  markPlaying(n, true);
  player.play().then(() => {
    if (fadeIn) fadeTo(1, FADE_IN_MS);
  }).catch(() => {
    player.volume = 1;
    state.audio.playing = false;
    paintPlay();
    $("#pState").textContent = "press play";
  });
}

function nextAyah(auto = false) {
  const total = state.audio.surahState?.ayahs || state.verses.length || 114;
  if (state.audio.ayah >= total) {
    if (auto) continueToNextSurah();
    return;
  }
  playAyah(state.audio.ayah + 1);
}

async function continueToNextSurah() {
  const next = state.surah >= 114 ? 1 : state.surah + 1;
  const surah = state.surahs.find((x) => x.number === next);
  const name = surah ? surah.name_en : `surah ${next}`;
  $("#pState").textContent = `fading into ${name}`;
  state.audio.advancing = true;
  try {
    await loadSurah(next);
    await reloadAudioForSurah();
  } catch (err) {
    toast("Could not continue to the next surah: " + err.message);
    return;
  } finally {
    state.audio.advancing = false;
  }
  fadeOutArmed = -1;
  playAyah(1, false, true);
}

function togglePlay() {
  if (!state.audio.active) {
    startListening();
    return;
  }
  if (player.paused) player.play().catch(() => {});
  else player.pause();
}

function paintPlay() {
  $("#pPlay").textContent = state.audio.playing ? "❚❚" : "▶";
  $("#pPlay").setAttribute("aria-label", state.audio.playing ? "Pause" : "Play");
}

function updateProgress() {
  const dur = player.duration;
  const pos = player.currentTime;
  $("#pFill").style.width = dur ? `${Math.min(100, (100 * pos) / dur)}%` : "0%";
  $("#pTime").textContent = fmtTime(pos);

  // Last verse of the surah: ease the volume down before the file ends, so the
  // hand-off to the next surah is a fade rather than a cut.
  const total = state.audio.surahState?.ayahs || 0;
  const onLastVerse = total && state.audio.ayah >= total;
  if (onLastVerse && dur && !player.paused && fadeOutArmed !== state.audio.ayah) {
    const left = dur - pos;
    if (left <= FADE_OUT_S) {
      fadeOutArmed = state.audio.ayah;
      fadeTo(0, Math.max(250, left * 1000));
    }
  }
}

function markPlaying(n, scroll) {
  const key = `${state.surah}:${n}`;
  const card = document.querySelector(`.verse[data-key="${key}"]`);
  for (const node of document.querySelectorAll(".verse")) {
    node.classList.toggle("playing", node.dataset.key === key);
  }
  // Only a verse start passes scroll=true, so this runs once per verse and
  // never on the progress ticks.
  if (scroll) followScroll(card);
}

function stopPlayback(silent = false) {
  stopFade();
  player.volume = 1;
  fadeOutArmed = -1;
  player.pause();
  player.removeAttribute("src");
  player.load();
  state.audio.active = false;
  state.audio.playing = false;
  state.audio.surah = null;
  $("#player").hidden = true;
  document.body.classList.remove("has-player");
  $("#pFill").style.width = "0%";
  $("#pTime").textContent = "0:00";
  for (const card of document.querySelectorAll(".verse.playing")) card.classList.remove("playing");
  paintPlay();
  if (silent !== true) $("#pState").textContent = "ready";
}

function downloadTranscript() {
  const s = state.surahs.find((x) => x.number === state.surah);
  if (!s) return;
  const lines = [
    `${s.name_en} · ${s.name_ar}`,
    `Surah ${s.number} of the Quran — ${s.ayahs} verses, ${s.revelation}`,
    "Verses verified letter-for-letter against Tanzil, Quran.com and Al Quran Cloud.",
    "",
  ];
  for (const v of state.verses) {
    lines.push(`[${v.key}]`);
    lines.push(v.text);
    const tr = v.translations[state.lang] || v.translations.en;
    if (tr) lines.push(tr);
    lines.push("");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `quran-${String(s.number).padStart(3, "0")}-${s.name_en.toLowerCase()}-transcript.txt` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("Transcript saved");
}

/* ---------- guides: talks + solat sunat ---------- */

/* Curated, not scraped. The list comes from guides/videos.json (long-form only,
   recorded from YouTube at curation time) and the tutorials from
   guides/solat.json, where every claim carries the page it rests on. The UI is
   Malay because the people it is for read Malay. */

const MALAY_MONTHS = ["Jan", "Feb", "Mac", "Apr", "Mei", "Jun", "Jul", "Ogo", "Sep", "Okt", "Nov", "Dis"];

state.guides = { data: null, error: null, tab: "khutbah", cat: "all", q: "", current: null };

function fmtDur(seconds) {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h) return m ? `${h} jam ${m} minit` : `${h} jam`;
  return `${m} minit`;
}

function fmtDate(value) {
  if (!value || !/^\d{8}$/.test(String(value))) return "";
  const d = String(value);
  const month = MALAY_MONTHS[Number(d.slice(4, 6)) - 1];
  return month ? `${Number(d.slice(6, 8))} ${month} ${d.slice(0, 4)}` : "";
}

function metaLine(v) {
  return [fmtDur(v.duration_s), fmtDate(v.upload_date)].filter(Boolean).join(" · ");
}

async function loadGuides() {
  if (state.guides.data) return state.guides.data;
  try {
    state.guides.data = await api("/api/guides");
  } catch (err) {
    state.guides.error = err.message;
  }
  return state.guides.data;
}

async function initGuides() {
  const btn = $("#guidesBtn");
  if (!btn) return;
  // Probing before the first click means the button never opens a dead end.
  btn.disabled = true;
  const data = await loadGuides();
  if (data && data.ok) {
    btn.disabled = false;
    return;
  }
  btn.hidden = true;
  if (data && (data.problems || []).length) console.warn("guides unavailable:", data.problems);
}

function openGuides(tab) {
  if (tab) state.guides.tab = tab === "solat" ? "solat" : "khutbah";  // #kuliah maps to the khutbah tab
  $("#guidesModal").hidden = false;
  if (location.hash !== "#" + (state.guides.tab === "solat" ? "solat" : "kuliah")) {
    setHash(state.guides.tab === "solat" ? "solat" : "kuliah");
  }
  renderGuides();
}

function closeGuides() {
  $("#guidesModal").hidden = true;
  setHash(state.surah ? String(state.surah) : "");
}

function guideTabButton(id) {
  for (const btn of document.querySelectorAll("#guidesTabs button")) {
    btn.classList.toggle("on", btn.dataset.gtab === id);
    btn.setAttribute("aria-selected", btn.dataset.gtab === id ? "true" : "false");
  }
}

async function renderGuides() {
  guideTabButton(state.guides.tab);
  const body = $("#guidesBody");
  body.replaceChildren(el("div", { class: "g-empty", text: "Memuatkan…" }));
  const data = await loadGuides();
  body.replaceChildren();
  if (!data) {
    body.append(el("div", { class: "g-empty" }, [
      el("strong", { text: "Kandungan ini tidak dapat dimuatkan. " }),
      state.guides.error || "",
    ]));
    return;
  }
  // The catalogue can be partial (a file was absent or failed validation). Say
  // so and show what is there — the alternative was a modal that only said 500.
  if (data.ok === false) {
    body.append(el("div", { class: "g-empty g-warn" }, [
      el("strong", { text: "Sebahagian kandungan tidak dapat dimuatkan. " }),
      document.createTextNode("Yang ada dipaparkan di bawah."),
      el("ul", {}, (data.problems || []).map((p) => el("li", { text: p }))),
    ]));
  }
  if (data.channel && data.channel.name) {
    body.append(el("div", { class: "g-intro" }, [
      el("div", {}, [
        el("strong", { text: data.channel.name }),
        document.createTextNode(
          ` · ${data.counts.total} kuliah penuh (${Math.round(data.min_duration_s / 60)} minit ke atas). ` +
          "Dimainkan melalui pemain rasmi YouTube; tiada video dimuat turun atau disimpan semula."
        ),
      ]),
      el("a", {
        href: data.channel.url,
        target: "_blank",
        rel: "noopener noreferrer",
        text: "Saluran rasmi ↗",
      }),
    ]));
  }
  // The channel's own limit, said where it is read rather than buried in a README:
  // the collection is kuliyyah/ceramah, and no full Friday khutbah is published there.
  if (state.guides.tab === "khutbah" && data.channel.note) {
    body.append(el("div", { class: "g-srcnote" }, [
      el("strong", { text: "Nota saluran: " }),
      data.channel.note,
    ]));
  }
  if (state.guides.tab === "solat") solatTab(body, data);
  else khutbahTab(body, data);
}

function embedBlock(v) {
  return el("div", { class: "g-player" }, [
    el("div", { class: "g-frame" }, [
      el("iframe", {
        src: v.embed,
        title: v.title,
        loading: "lazy",
        allow: "accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen",
        allowfullscreen: true,
        referrerpolicy: "strict-origin-when-cross-origin",
      }),
    ]),
    el("div", { class: "g-pmeta" }, [
      el("div", { class: "g-ptitle", text: v.title }),
      el("div", { class: "g-prow" }, [
        el("span", { class: "g-cat", text: v.category_label }),
        el("span", { class: "g-meta", text: metaLine(v) }),
        el("span", { class: "spacer" }),
        el("a", { href: v.url, target: "_blank", rel: "noopener noreferrer", text: "Buka di YouTube ↗" }),
        el("button", { class: "g-x", text: "Tutup pemain", onclick: () => { state.guides.current = null; renderGuides(); } }),
      ]),
    ]),
  ]);
}

function khutbahTab(body, data) {
  if (state.guides.current) body.append(embedBlock(state.guides.current));

  const search = el("input", {
    type: "search",
    class: "g-search",
    placeholder: "Cari tajuk kuliah…",
    "aria-label": "Cari tajuk kuliah",
    value: state.guides.q,
  });
  const chips = el("div", { class: "g-chips" });
  const list = el("div", { class: "g-list" });
  const count = el("span", { class: "g-count" });

  const visible = () => {
    const needle = state.guides.q.trim().toLowerCase();
    return data.videos.filter((v) => {
      if (state.guides.cat !== "all" && v.category !== state.guides.cat) return false;
      return !needle || v.title.toLowerCase().includes(needle);
    });
  };

  const paint = () => {
    const rows = visible();
    count.textContent = `${rows.length} daripada ${data.videos.length}`;
    list.replaceChildren();
    if (!rows.length) {
      list.append(el("div", { class: "g-empty", text: "Tiada kuliah yang sepadan. Cuba kategori lain atau padam carian." }));
      return;
    }
    for (const v of rows) {
      list.append(el("button", {
        class: "g-item" + (state.guides.current?.id === v.id ? " on" : ""),
        onclick: () => { state.guides.current = v; renderGuides(); },
      }, [
        el("span", { class: "g-cat", text: v.category_label }),
        el("span", { class: "g-title", text: v.title }),
        el("span", { class: "g-meta", text: metaLine(v) }),
      ]));
    }
  };

  // Each chip remembers its own element, so the active state is honest.
  for (const [id, label, n] of [["all", "Semua", data.videos.length], ...data.categories.filter((c) => c.count).map((c) => [c.id, c.label, c.count])]) {
    const btn = el("button", { class: "g-chip" + (state.guides.cat === id ? " on" : ""), dataset: { cat: id } }, [
      label,
      el("span", { class: "n", text: n }),
    ]);
    btn.onclick = () => {
      state.guides.cat = id;
      for (const b of chips.children) b.classList.toggle("on", b === btn);
      paint();
    };
    chips.append(btn);
  }

  search.addEventListener("input", (e) => { state.guides.q = e.target.value; paint(); });

  body.append(
    el("div", { class: "g-toolbar" }, [search, el("span", { class: "spacer" }), count]),
    chips,
    list,
  );
  paint();
}

function niatBlock(niat) {
  // Only the lafaz can honestly be called a "lafaz". When it could not be copied
  // from a source, the block drops to the meaning and says why — a niat that is
  // recited is exactly the wrong place to reconstruct text from memory.
  const hasArabic = Boolean(niat?.ar);
  const box = el("div", { class: "g-niat" }, [
    el("div", { class: "g-label", text: hasArabic ? "Lafaz niat" : "Maksud niat" }),
  ]);
  if (hasArabic) box.append(el("div", { class: "g-ar", lang: "ar", dir: "rtl", text: niat.ar }));
  if (niat?.rumi) box.append(el("div", { class: "g-rumi", text: niat.rumi }));
  if (niat?.ms) box.append(el("div", { class: hasArabic ? "g-ms" : "g-maksud", text: niat.ms }));
  return box;
}

function solatCard(t) {
  const head = el("summary", {}, [
    el("span", { class: "g-card-title", text: t.nama }),
    el("span", { class: "g-card-chips" }, [
      t.hukum ? el("span", { class: "tag", text: t.hukum }) : null,
      t.rakaat ? el("span", { class: "tag", text: t.rakaat }) : null,
    ]),
  ]);
  const body = el("div", { class: "g-card-body" });
  if (t.ringkasan) body.append(el("p", { text: t.ringkasan }));
  if (t.waktu) body.append(el("p", { class: "g-waktu" }, [el("strong", { text: "Waktu: " }), t.waktu]));
  body.append(niatBlock(t.niat || {}));
  if ((t.langkah || []).length) {
    body.append(el("div", { class: "g-label", text: "Cara mengerjakan" }));
    const ol = el("ol", { class: "g-steps" });
    for (const s of t.langkah) {
      ol.append(el("li", {}, [s.tajuk ? el("strong", { text: s.tajuk + " — " }) : null, s.teks || ""]));
    }
    body.append(ol);
  }
  if ((t.fadhilat || []).length) {
    body.append(el("div", { class: "g-label", text: "Fadhilat" }));
    const ul = el("ul", { class: "g-fadhilat" });
    for (const f of t.fadhilat) ul.append(el("li", { text: f }));
    body.append(ul);
  }
  if (t.nota) body.append(el("div", { class: "g-note", text: t.nota }));
  if ((t.sumber || []).length) {
    body.append(el("div", { class: "g-label", text: "Sumber" }));
    const box = el("div", { class: "g-src" });
    for (const s of t.sumber) {
      box.append(el("div", { class: "g-src-item" }, [
        el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer", text: s.nama || s.url }),
        s.quote ? el("blockquote", { text: `“${s.quote}”` }) : null,
      ]));
    }
    body.append(box);
  }
  return el("details", { class: "g-card", open: true }, [head, body]);
}

function solatTab(body, data) {
  body.append(el("p", { class: "g-lead", text:
    "Empat solat sunat harian: rawatib, dhuha, tahajjud dan witir. Setiap panduan menyebut " +
    "sumbernya — JAKIM, Pejabat Mufti Wilayah Persekutuan, atau sunnah.com — berserta petikan " +
    "asal, supaya boleh disemak sendiri. Di mana ulama berbeza pendapat, perbezaan itu " +
    "dinyatakan, bukan dipilih secara senyap." }));
  for (const t of data.solat) body.append(solatCard(t));
  body.append(el("div", { class: "g-note", text: data.sumber_nota }));
}

/* Wiring lives here rather than in boot() so the panel is optional: if the
   button or the modal is missing, nothing above runs and the app boots as before. */
if ($("#guidesBtn") && $("#guidesModal")) {
  $("#guidesBtn").onclick = () => openGuides();
  $("#guidesClose").onclick = closeGuides;
  $("#guidesModal").addEventListener("click", (e) => {
    if (e.target.id === "guidesModal") closeGuides();
  });
  for (const btn of document.querySelectorAll("#guidesTabs button")) {
    btn.onclick = () => openGuides(btn.dataset.gtab);
  }
}

/* ---------- hash routing ---------- */

function setHash(value) {
  state.suppressHash = true;
  location.hash = value ? `#${value}` : "";
  setTimeout(() => (state.suppressHash = false), 0);
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  if (!raw) return {};
  if (raw === "kuliah" || raw === "solat") return { guides: raw };  // #kuliah / #solat open the sheet
  const m = raw.match(/^(\d{1,3})(?::(\d{1,3}))?$/);
  if (!m) return {};
  return { surah: Number(m[1]), ayah: m[2] ? Number(m[2]) : null };
}

async function handleHash() {
  if (state.suppressHash) return;
  const { surah, ayah, guides } = parseHash();
  if (guides) {
    openGuides(guides);
    return;
  }
  if (!surah) return;
  if (state.search.q) {
    state.search = { q: "", results: [], mode: null, busy: false };
    $("#q").value = "";
  }
  if (surah !== state.surah) await loadSurah(surah, ayah);
  else if (ayah) {
    selectVerse(`${surah}:${ayah}`);
    document.querySelector(`.verse[data-key="${surah}:${ayah}"]`)?.scrollIntoView({ block: "center" });
  }
}

/* ---------- boot ---------- */

async function boot() {
  initTheme();
  initVerseSize();
  initReading();
  initMarks();
  const savedLang = store("bayan.lang");
  if (savedLang === "ms" || savedLang === "en") state.lang = savedLang;
  for (const btn of document.querySelectorAll("#langSeg button")) {
    btn.classList.toggle("on", btn.dataset.lang === state.lang);
    btn.onclick = () => setLang(btn.dataset.lang);
  }

  $("#themeBtn").onclick = () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  };

  try {
    const [status, surahs] = await Promise.all([api("/api/status"), api("/api/surahs")]);
    state.status = status;
    state.surahs = surahs;
    const label = $("#statusLabel");
    label.textContent = `${status.totals.three_of_three.toLocaleString()} / ${status.totals.verses.toLocaleString()} · 3 sources`;
    $("#statusBtn .dot").className = "dot " + (status.ok ? "ok" : "bad");
    $("#statusBtn").onclick = () => {
      $("#statusModal").hidden = false;
      renderStatus();
    };
    $("#statusClose").onclick = () => ($("#statusModal").hidden = true);
    $("#statusModal").addEventListener("click", (e) => {
      if (e.target.id === "statusModal") $("#statusModal").hidden = true;
    });
    renderSurahs();
    initGuides();  // probe in the background; hides the button if the catalogue is broken
  } catch (err) {
    $("#statusLabel").textContent = "corpus error";
    $("#readerInner").replaceChildren(el("div", { class: "empty", text: (window.BAYAN_STATIC ? "Cannot load the corpus: " : "Cannot reach the local service: ") + err.message }));
    return;
  }

  $("#surahFilter").addEventListener("input", (e) => renderSurahs(e.target.value));
  $("#menuBtn").onclick = () => {
    if ($(".sidebar").classList.contains("open")) closeDrawer();
    else openDrawer();
  };
  document.addEventListener("click", (e) => {
    if (!$(".sidebar").classList.contains("open")) return;
    if (e.target.closest(".sidebar") || e.target.closest("#menuBtn")) return;
    closeDrawer();
  });
  $("#q").addEventListener("input", (e) => onSearchInput(e.target.value));
  $("#q").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.target.value = "";
      onSearchInput("");
      e.target.blur();
    }
  });
  $("#randomBtn").onclick = async () => {
    try {
      const { key } = await api("/api/random");
      jumpTo(...key.split(":").map(Number));
    } catch (err) {
      toast("Random failed: " + err.message);
    }
  };

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
    if (e.key === "/" && !typing) {
      e.preventDefault();
      $("#q").focus();
    } else if (e.key === "Escape") {
      if (!$("#readingPanel").hidden) closeReading();
      else if ($(".sidebar").classList.contains("open")) closeDrawer();
      else if (!$("#guidesModal").hidden) closeGuides();
      else if (!$("#statusModal").hidden) $("#statusModal").hidden = true;
      else if (!$("#inspector").hidden && !typing) closeInspector();
    } else if (!typing && e.key === " " && state.audio.active) {
      e.preventDefault();
      togglePlay();
    } else if (!typing && (e.key === "j" || e.key === "k")) {
      const keys = state.verses.map((v) => v.key);
      const idx = keys.indexOf(state.selected);
      const next = e.key === "j" ? idx + 1 : idx - 1;
      if (next >= 0 && next < keys.length) {
        selectVerse(keys[next]);
        document.querySelector(`.verse[data-key="${keys[next]}"]`)?.scrollIntoView({ block: "center" });
      }
    }
  });

  window.addEventListener("hashchange", handleHash);

  try {
    await initAudio();
  } catch (err) {
    toast("Recitation unavailable: " + err.message);
  }

  const { surah: hashSurah, ayah: hashAyah, guides: hashGuides } = parseHash();
  const lastSurah = Number(store("bayan.surah")) || 1;
  const target = hashSurah || lastSurah;
  await loadSurah(target, hashAyah);
  if (hashGuides) openGuides(hashGuides);
  if (!hashAyah) {
    const lastVerse = store("bayan.verse");
    if (lastVerse && lastVerse.startsWith(`${target}:`)) {
      selectVerse(lastVerse, { keepHash: true });
    }
  }
}

boot();
