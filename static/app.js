/* Bayan — reader + verification inspector. No framework, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  surahs: [],
  surah: null,
  verses: [],
  selected: null,
  lang: "en",
  status: null,
  search: { q: "", results: [], mode: null, busy: false },
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

function renderSurahs(filter = "") {
  const list = $("#surahList");
  const needle = filter.trim().toLowerCase();
  list.replaceChildren();
  let shown = 0;
  for (const s of state.surahs) {
    const hay = `${s.number} ${s.name_en} ${s.name_ar_short} ${s.meaning}`.toLowerCase();
    if (needle && !hay.includes(needle)) continue;
    shown++;
    const row = el("div", {
      class: "surah-row" + (state.surah === s.number ? " on" : ""),
      dataset: { n: s.number },
      role: "button",
      tabindex: "0",
      onclick: () => loadSurah(s.number),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") loadSurah(s.number);
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
  if (state.audio.surah && state.audio.surah !== number) stopPlayback(true);
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
  out.replaceChildren(el("span", { text: "Contacting Tanzil, Quran.com and Al Quran Cloud… Tanzil re-downloads its whole 1.3 MB text file, so this can take up to a minute." }));
  try {
    const res = await api(`/api/verify/${key}`);
    out.replaceChildren();
    const lines = [];
    for (const src of res.sources) {
      if (src.error) {
        lines.push(el("div", {}, [el("span", { class: "err", text: "✕ " }), `${src.name}: ${src.error}`]));
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
        [`Checked just now in ${res.seconds}s — ${res.agreeing} of ${res.responding} answering sources agree` +
         (res.responding < res.total ? ` (${res.total - res.responding} unreachable)` : "")]),
      ...lines,
      el("div", { style: "margin-top:6px;color:var(--faint)" },
        ["Cached corpus is not consulted for the verdict; the texts above were fetched live."]),
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

  body.append(el("h3", { text: "Integrity checks (run against the database now)" }));
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
  player.addEventListener("play", () => { state.audio.playing = true; paintPlay(); });
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

function startListening(ayah) {
  openPlayer();
  const from = ayah || (state.selected && Number(state.selected.split(":")[1])) || 1;
  playAyah(from);
}

function playAyah(n, resume = false) {
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
  player.src = url;
  if (!resume) player.currentTime = 0;
  $("#pState").textContent = local ? "playing from download" : "streaming";
  const surah = state.surahs.find((x) => x.number === state.surah);
  $("#pRef").textContent = `${state.surah}:${n}`;
  $("#pSurah").textContent = surah ? surah.name_en : "";
  markPlaying(n, true);
  player.play().catch(() => {
    state.audio.playing = false;
    paintPlay();
    $("#pState").textContent = "press play";
  });
}

function nextAyah(auto = false) {
  const total = state.audio.surahState?.ayahs || state.verses.length || 114;
  if (state.audio.ayah >= total) {
    if (auto) {
      state.audio.playing = false;
      paintPlay();
      $("#pState").textContent = "surah finished";
    }
    return;
  }
  playAyah(state.audio.ayah + 1);
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
}

function markPlaying(n, scroll) {
  const key = `${state.surah}:${n}`;
  for (const card of document.querySelectorAll(".verse")) {
    card.classList.toggle("playing", card.dataset.key === key);
  }
  if (scroll) ensureVisible(document.querySelector(`.verse[data-key="${key}"]`));
}

function stopPlayback(silent = false) {
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

/* ---------- hash routing ---------- */

function setHash(value) {
  state.suppressHash = true;
  location.hash = value ? `#${value}` : "";
  setTimeout(() => (state.suppressHash = false), 0);
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  if (!raw) return {};
  const m = raw.match(/^(\d{1,3})(?::(\d{1,3}))?$/);
  if (!m) return {};
  return { surah: Number(m[1]), ayah: m[2] ? Number(m[2]) : null };
}

async function handleHash() {
  if (state.suppressHash) return;
  const { surah, ayah } = parseHash();
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
  } catch (err) {
    $("#statusLabel").textContent = "corpus error";
    $("#readerInner").replaceChildren(el("div", { class: "empty", text: "Cannot reach the local service: " + err.message }));
    return;
  }

  $("#surahFilter").addEventListener("input", (e) => renderSurahs(e.target.value));
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
      if (!$("#statusModal").hidden) $("#statusModal").hidden = true;
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

  const { surah: hashSurah, ayah: hashAyah } = parseHash();
  const lastSurah = Number(store("bayan.surah")) || 1;
  const target = hashSurah || lastSurah;
  await loadSurah(target, hashAyah);
  if (!hashAyah) {
    const lastVerse = store("bayan.verse");
    if (lastVerse && lastVerse.startsWith(`${target}:`)) {
      selectVerse(lastVerse, { keepHash: true });
    }
  }
}

boot();
