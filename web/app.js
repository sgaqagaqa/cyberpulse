"use strict";

// CyberPulse web app. Plain JavaScript, no build step, no dependencies.
// Feed content comes from third parties, so everything is rendered with textContent
// (never innerHTML) and links are limited to http(s).

const FEED_URL = "feed.json";
const REFRESH_MS = 5 * 60 * 1000;
const WINDOWS = [["hour", "Hour"], ["day", "Day"], ["week", "Week"], ["year", "Year"]];
const FILTERS = [
  ["all", "All", () => true],
  ["critical", "Critical", (i) => i.severity === "critical"],
  ["threats", "Threats", (i) => i.category === "threat" || i.tags.some((t) => ["ransomware", "malware", "apt", "breach"].includes(t))],
  ["vulns", "Vulnerabilities", (i) => i.category === "vuln" || i.tags.includes("vuln")],
  ["sa", "South Africa", (i) => i.tags.includes("sa")],
  ["industry", "IT news", (i) => i.category === "industry" || i.category === "news"],
  ["posts", "Posts", (i) => i.category === "posts"],
];
const TOPIC_LABELS = {
  ransomware: "Ransomware", phishing: "Phishing and scams", vuln: "Vulnerabilities", breach: "Data breaches",
  malware: "Malware", apt: "Nation-state attacks", ai: "AI", cloud: "Cloud", ot: "Industrial and OT",
  mobile: "Mobile", privacy: "Privacy", popia: "POPIA", banking: "Banking and fraud", skills: "Skills and jobs",
  sa: "South Africa", idea: "Ideas",
};
const TABS = [
  ["home", "Home", "home"],
  ["sa", "South Africa", "flag"],
  ["saved", "Saved", "bookmark"],
  ["thoughts", "My thoughts", "pen"],
];
const ICONS = {
  home: "M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  flag: "M5 21V4|M5 4h12l-2.5 4 2.5 4H5",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  pen: "M12 20h9|M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  comment: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  share: "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7|M16 6l-4-4-4 4|M12 2v14",
  open: "M14 3h7v7|M21 3l-9 9|M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5",
  refresh: "M21 12a9 9 0 1 1-3-6.7|M21 4v5h-5",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z|M21 21l-4.3-4.3",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z|M12 2v2|M12 20v2|M4.9 4.9l1.4 1.4|M17.7 17.7l1.4 1.4|M2 12h2|M20 12h2|M4.9 19.1l1.4-1.4|M17.7 6.3l1.4-1.4",
  up: "M12 19V5|M5 12l7-7 7 7",
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- storage

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked: app still works */ }
}

const prefs = load("cp.prefs", {}) || {};
const state = {
  feed: null,
  pending: null,
  tab: "home",
  win: WINDOWS.some((w) => w[0] === prefs.win) ? prefs.win : "day",
  filter: FILTERS.some((f) => f[0] === prefs.filter) ? prefs.filter : "all",
  tag: "",
  q: "",
  saved: arr(load("cp.saved", [])),
  notes: obj(load("cp.notes", {})),
  read: new Set(arr(load("cp.read", []))),
  open: new Set(),
  drafts: {},
  error: "",
  loading: false,
  lastFetch: 0,
};
function arr(v) { return Array.isArray(v) ? v : []; }
function obj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
const savePrefs = () => store("cp.prefs", prefs);
const persistSaved = () => store("cp.saved", state.saved);
const persistNotes = () => store("cp.notes", state.notes);
function persistRead() { store("cp.read", Array.from(state.read).slice(-1500)); }

// ---------------------------------------------------------------- dom helpers

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}
const SVG_NS = "http://www.w3.org/2000/svg";
function icon(name, size = 20, filled = false) {
  const s = document.createElementNS(SVG_NS, "svg");
  const attrs = { viewBox: "0 0 24 24", width: size, height: size, fill: filled ? "currentColor" : "none", stroke: "currentColor",
    "stroke-width": "1.9", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  ICONS[name].split("|").forEach((d) => {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    s.append(p);
  });
  return s;
}
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);

function ago(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 60 ? `${days}d` : `${Math.round(days / 30)}mo`;
}
function fmtTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const topicLabel = (t) => TOPIC_LABELS[t] || t;
let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1900);
}
function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
}

// ---------------------------------------------------------------- data

async function refresh(manual) {
  if (state.loading) return;
  state.loading = true;
  $("refresh").classList.add("spin");
  try {
    const res = await fetch(`${FEED_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const initial = !state.lastFetch;
    state.lastFetch = Date.now();
    state.error = "";
    store("cp.feed", data);
    if (!state.feed || manual || initial) {
      state.feed = data;
      state.pending = null;
      render();
    } else if (data.generated_at !== state.feed.generated_at) {
      const known = new Set([...(state.feed.hour || []), ...(state.feed.day || [])].map((i) => i.id));
      const fresh = (data.day || []).filter((i) => !known.has(i.id)).length;
      if (fresh > 0) {
        state.pending = { data, fresh };
      } else {
        state.feed = data;
      }
      renderHeader();
      renderRail();
    }
    if (manual) toast("Feed refreshed");
  } catch (e) {
    const cached = load("cp.feed", null);
    if (cached && !state.feed) state.feed = cached;
    state.error = state.feed
      ? "You are offline or the feed is unavailable. Showing the last feed you loaded."
      : "The feed is not available yet. Run the Build feed action on GitHub once, then reload.";
    render();
  } finally {
    state.loading = false;
    $("refresh").classList.remove("spin");
    renderHeader();
  }
}

function applyPending() {
  if (!state.pending) return;
  state.feed = state.pending.data;
  state.pending = null;
  render();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- saves and notes

const isSaved = (item) => state.saved.some((s) => s.id === item.id);
const notesFor = (id) => (state.notes[id] && state.notes[id].notes) || [];

function snapshot(item) {
  return {
    id: String(item.id), title: String(item.title || ""), summary: String(item.summary || "").slice(0, 300),
    link: String(item.link || ""), source: String(item.source || ""), category: String(item.category || "news"),
    tags: arr(item.tags).map(String).slice(0, 8), severity: String(item.severity || "normal"),
    published: String(item.published || new Date().toISOString()), also: arr(item.also).map(String).slice(0, 6),
    extra: item.extra ? String(item.extra).slice(0, 400) : "",
  };
}
function toggleSave(item) {
  const i = state.saved.findIndex((s) => s.id === item.id);
  if (i >= 0) { state.saved.splice(i, 1); toast("Removed from saved"); }
  else { state.saved.unshift(snapshot(item)); toast("Saved"); }
  persistSaved();
  if (state.tab === "saved") renderList(); else refreshCard(item.id);
  renderCounts();
}
function addNote(item, text) {
  const rec = state.notes[item.id] || (state.notes[item.id] = { item: snapshot(item), notes: [] });
  rec.notes.push({ id: uid(), text, ts: new Date().toISOString() });
  persistNotes();
  renderCounts();
}
function editNote(itemId, noteId, text) {
  const n = notesFor(itemId).find((x) => x.id === noteId);
  if (n) { n.text = text; n.edited = true; persistNotes(); }
}
function deleteNote(itemId, noteId) {
  const rec = state.notes[itemId];
  if (!rec) return;
  rec.notes = rec.notes.filter((n) => n.id !== noteId);
  if (!rec.notes.length) delete state.notes[itemId];
  persistNotes();
  renderCounts();
}
function afterNoteChange(id) {
  if (state.tab === "thoughts" && !state.notes[id]) renderList(); else refreshCard(id);
}

async function share(item) {
  const mine = notesFor(item.id).slice(-1)[0];
  const text = mine ? `${item.title}\n\nMy take: ${mine.text}` : item.title;
  const data = { title: item.title, text, url: safeUrl(item.link) || undefined };
  if (navigator.share) {
    try { await navigator.share(data); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(`${text}${data.url ? `\n${data.url}` : ""}`);
    toast("Copied to your clipboard");
  } catch (e) {
    toast("Could not share from this browser");
  }
}

function exportBackup() {
  const data = { app: "cyberpulse", version: 2, exported: new Date().toISOString(), saved: state.saved, notes: state.notes };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `cyberpulse-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  toast("Backup downloaded");
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== "cyberpulse") throw new Error("not a CyberPulse backup");
    let added = 0;
    arr(data.saved).forEach((s) => {
      if (s && typeof s.id === "string" && typeof s.title === "string" && !state.saved.some((x) => x.id === s.id)) {
        state.saved.push(snapshot(s)); added++;
      }
    });
    Object.entries(obj(data.notes)).forEach(([id, rec]) => {
      if (!rec || !rec.item || !Array.isArray(rec.notes)) return;
      const mine = state.notes[id] || (state.notes[id] = { item: snapshot({ ...rec.item, id }), notes: [] });
      rec.notes.forEach((n) => {
        if (n && typeof n.text === "string" && !mine.notes.some((x) => x.id === n.id)) {
          mine.notes.push({ id: String(n.id || uid()), text: n.text.slice(0, 2000), ts: String(n.ts || new Date().toISOString()), edited: !!n.edited });
          added++;
        }
      });
      mine.notes.sort((a, b) => a.ts.localeCompare(b.ts));
      if (!mine.notes.length) delete state.notes[id];
    });
    persistSaved(); persistNotes();
    render();
    toast(added ? `Restored ${added} saved item${added === 1 ? "" : "s"} and thoughts` : "Nothing new in that backup");
  } catch (e) {
    toast("That file is not a CyberPulse backup");
  }
}

// ---------------------------------------------------------------- cards

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function avatar(item) {
  const hue = hash(item.source || "x") % 360;
  const words = (item.source || "").replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const label = item.category === "idea" ? "\u{1F4A1}" : ((words[0] || "?")[0] + (words[1] ? words[1][0] : "")).toUpperCase();
  return el("div", { class: "avatar", style: `background:linear-gradient(135deg,hsl(${hue} 62% 46%),hsl(${(hue + 45) % 360} 62% 34%))` }, label);
}

function act(iconName, label, onclick, cls, filled) {
  return el("button", { class: `act ${cls || ""}`.trim(), "aria-label": label, title: label, onclick }, icon(iconName, 19, !!filled), label.match(/^\d/) ? label.split(" ")[0] : null);
}

function buildCard(item, opts = {}) {
  const url = safeUrl(item.link);
  const saved = isSaved(item);
  const notes = notesFor(item.id);
  const isOpen = opts.forceOpen || state.open.has(item.id);
  const idea = item.category === "idea";

  const title = url
    ? el("a", { class: "c-title", href: url, target: "_blank", rel: "noopener noreferrer", onclick: () => markRead(item.id) }, item.title)
    : el("span", { class: "c-title" }, item.title);

  const tags = (item.tags || []).filter((t) => t !== "sa" && t !== "idea").slice(0, 4);
  const also = item.also || [];

  const noteBtn = el("button", {
    class: `act ${notes.length ? "has-notes" : ""}`.trim(),
    "aria-label": notes.length ? `${notes.length} thought${notes.length === 1 ? "" : "s"}, open` : "Write a thought",
    title: "My thoughts",
    onclick: () => toggleNotes(item, opts),
  }, icon("comment", 19, notes.length > 0), notes.length ? String(notes.length) : null);

  const card = el("article", { class: `card ${item.severity === "critical" ? "critical" : ""} ${state.read.has(item.id) ? "read" : ""}`.trim() },
    el("div", { class: "c-top" },
      avatar(item),
      el("div", { class: "c-body" },
        el("div", { class: "c-who" },
          el("span", { class: "c-source" }, item.source),
          idea ? null : el("span", { class: "c-time" }, ago(item.published)),
          item.severity === "critical" ? el("span", { class: "pill critical" }, "Critical") : null,
          item.severity === "high" ? el("span", { class: "pill high" }, "High") : null,
          (item.tags || []).includes("sa") && !idea ? el("span", { class: "pill sa" }, "South Africa") : null,
        ),
        title,
        item.summary ? el("p", { class: "c-summary" }, item.summary) : null,
        item.extra ? el("p", { class: "c-extra" }, item.extra) : null,
        also.length ? el("p", { class: "c-also" }, `Also reported by ${also.slice(0, 2).join(", ")}${also.length > 2 ? ` and ${also.length - 2} more` : ""}`) : null,
        tags.length ? el("div", { class: "c-tags" }, tags.map((t) => el("button", { class: "tag", onclick: () => setTag(t) }, `#${topicLabel(t)}`))) : null,
        el("div", { class: "actions" },
          noteBtn,
          el("button", { class: `act ${saved ? "saved" : ""}`.trim(), "aria-label": saved ? "Remove from saved" : "Save", title: saved ? "Saved" : "Save", onclick: () => toggleSave(item) }, icon("bookmark", 19, saved)),
          el("button", { class: "act", "aria-label": "Share", title: "Share", onclick: () => share(item) }, icon("share", 19)),
          url ? el("a", { class: "act", href: url, target: "_blank", rel: "noopener noreferrer", "aria-label": "Read the story", title: "Read the story", onclick: () => markRead(item.id) }, icon("open", 19)) : null,
        ),
      ),
    ),
    isOpen ? notesPanel(item) : null,
  );
  card.dataset.id = item.id;
  card._item = item;
  card._opts = opts;
  return card;
}

function markRead(id) {
  if (state.read.has(id)) return;
  state.read.add(id);
  persistRead();
  document.querySelectorAll(".card").forEach((c) => { if (c.dataset.id === id) c.classList.add("read"); });
}

function refreshCard(id, focus) {
  document.querySelectorAll(".card").forEach((c) => {
    if (c.dataset.id !== id || !c._item) return;
    const fresh = buildCard(c._item, c._opts);
    c.replaceWith(fresh);
    if (focus) {
      const ta = fresh.querySelector(".note-compose .note-input");
      if (ta) { ta.focus(); autosize(ta); }
    }
  });
}
function toggleNotes(item, opts) {
  if (opts && opts.forceOpen) {
    const ta = document.querySelector(`.card[data-id="${item.id.replace(/"/g, "")}"] .note-compose .note-input`);
    if (ta) ta.focus();
    return;
  }
  if (state.open.has(item.id)) state.open.delete(item.id); else state.open.add(item.id);
  refreshCard(item.id, state.open.has(item.id));
}

function notesPanel(item) {
  const list = notesFor(item.id);
  const wrap = el("div", { class: "notes" });
  list.forEach((n) => wrap.append(noteRow(item, n)));

  const ta = el("textarea", { class: "note-input", rows: "2", maxlength: "2000", placeholder: "What do you make of this? Write your thoughts.", "aria-label": "Your thoughts" });
  ta.value = state.drafts[item.id] || "";
  const post = el("button", { class: "btn primary small", onclick: submit }, "Save thought");
  post.disabled = !ta.value.trim();
  ta.addEventListener("input", () => { state.drafts[item.id] = ta.value; post.disabled = !ta.value.trim(); autosize(ta); });
  ta.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(); });
  function submit() {
    const text = ta.value.trim();
    if (!text) return;
    addNote(item, text);
    delete state.drafts[item.id];
    state.open.add(item.id);
    refreshCard(item.id);
    toast("Thought saved");
  }
  wrap.append(el("div", { class: "note-compose" }, ta, el("div", { class: "note-foot" }, el("span", { class: "hint" }, "Private. Stored on this device."), post)));
  return wrap;
}

function noteRow(item, n) {
  const body = el("div", { class: "note-text" }, n.text);
  const edit = el("button", { class: "link-btn", onclick: startEdit }, "Edit");
  const del = el("button", { class: "link-btn", onclick: remove }, "Delete");
  const row = el("div", { class: "note" },
    el("div", { class: "note-meta" }, el("span", {}, `You, ${fmtTime(n.ts)}${n.edited ? ", edited" : ""}`), el("span", { class: "note-btns" }, edit, del)),
    body);
  function startEdit() {
    const ta = el("textarea", { class: "note-input", rows: "3", maxlength: "2000", "aria-label": "Edit your thought" });
    ta.value = n.text;
    ta.addEventListener("input", () => autosize(ta));
    const save = el("button", { class: "btn primary small", onclick: () => {
      const t = ta.value.trim();
      if (!t) return;
      editNote(item.id, n.id, t);
      refreshCard(item.id);
      toast("Thought updated");
    } }, "Update thought");
    const cancel = el("button", { class: "btn small", onclick: () => refreshCard(item.id) }, "Cancel");
    body.replaceChildren(ta, el("div", { class: "note-foot" }, cancel, save));
    autosize(ta);
    ta.focus();
  }
  function remove() {
    if (!window.confirm("Delete this thought?")) return;
    deleteNote(item.id, n.id);
    afterNoteChange(item.id);
    toast("Thought deleted");
  }
  return row;
}

// ---------------------------------------------------------------- filtering

function setTag(t) {
  state.tag = t;
  if (state.tab === "thoughts") state.tab = "home";
  render();
  window.scrollTo(0, 0);
}
function matchesQuery(i) {
  const q = state.q.trim().toLowerCase();
  if (!q) return true;
  return `${i.title} ${i.summary || ""} ${i.source} ${(i.tags || []).map(topicLabel).join(" ")}`.toLowerCase().includes(q);
}
const matchesTag = (i) => !state.tag || (i.tags || []).includes(state.tag);

function ideaItem(idea, feed) {
  return {
    id: `idea:${idea.id}`, title: idea.title, summary: idea.action,
    extra: `${idea.why}${idea.evidence_title ? ` Evidence: ${idea.evidence_title}` : ""}`,
    link: idea.evidence_link || "", source: "SA opportunity", category: "idea", tags: ["sa", "idea"],
    severity: "normal", published: feed.generated_at, also: [],
  };
}

// ---------------------------------------------------------------- rendering

function emptyState(iconName, heading, text) {
  return el("div", { class: "empty" }, icon(iconName, 40), el("h3", {}, heading), el("p", {}, text));
}
function skeletons() {
  return [1, 2, 3, 4].map(() => el("div", { class: "skel" }, el("i", { class: "a" }), el("div", { class: "l" }, el("i", { style: "width:40%" }), el("i", { style: "width:92%" }), el("i", { style: "width:78%" }))));
}
function backupBox(cls) {
  return el("section", { class: `box ${cls || ""}`.trim() },
    el("h2", {}, "Back up"),
    el("p", {}, "Your saves and thoughts live on this device. Download a backup to keep them safe or move them to another device."),
    el("div", { class: "backup" },
      el("button", { class: "btn small", onclick: exportBackup }, "Download backup"),
      el("button", { class: "btn small", onclick: () => $("importFile").click() }, "Restore from file")));
}

function renderList() {
  const list = $("list");
  const feed = state.feed;
  const nodes = [];

  if (state.tab === "saved") {
    const items = state.saved.filter((i) => matchesQuery(i) && matchesTag(i));
    items.forEach((i) => nodes.push(buildCard(i)));
    if (!items.length) nodes.push(state.saved.length
      ? emptyState("search", "No matches", "Try a different search or clear the topic.")
      : emptyState("bookmark", "Nothing saved yet", "Tap the bookmark on any story to keep it here."));
    nodes.push(backupBox("mobile-only"));
  } else if (state.tab === "thoughts") {
    const recs = Object.values(state.notes)
      .filter((r) => r.notes && r.notes.length && matchesQuery(r.item))
      .sort((a, b) => b.notes[b.notes.length - 1].ts.localeCompare(a.notes[a.notes.length - 1].ts));
    recs.forEach((r) => nodes.push(buildCard(r.item, { forceOpen: true })));
    if (!recs.length) nodes.push(Object.keys(state.notes).length
      ? emptyState("search", "No matches", "Try a different search.")
      : emptyState("pen", "No thoughts yet", "Tap the speech bubble on any story to write what you think. Everything you write collects here."));
    nodes.push(backupBox("mobile-only"));
  } else if (!feed) {
    if (state.error) nodes.push(emptyState("refresh", "No feed yet", state.error));
    else nodes.push(...skeletons());
  } else if (state.tab === "sa") {
    const ideas = (feed.sa_ideas || []).map((i) => ideaItem(i, feed)).filter(matchesQuery);
    if (ideas.length) {
      nodes.push(el("h2", { class: "section-title" }, "Ideas to move South Africa forward"));
      nodes.push(el("p", { class: "section-sub" }, "Picked from this week's news. Write your own plan under any of them."));
      ideas.forEach((i) => nodes.push(buildCard(i)));
    }
    nodes.push(el("h2", { class: "section-title" }, "South African stories this week"));
    const stories = (feed.week || []).filter((i) => i.tags.includes("sa") && matchesQuery(i) && matchesTag(i));
    stories.forEach((i) => nodes.push(buildCard(i)));
    if (!stories.length) nodes.push(emptyState("flag", "No South African stories", "Nothing from the last 7 days matches. Check back after the next hourly update."));
  } else {
    const plain = state.filter === "all" && !state.tag && !state.q.trim();
    if (state.win === "year" && plain && (feed.reports || []).length) {
      nodes.push(el("h2", { class: "section-title" }, "Annual reports worth reading"));
      feed.reports.forEach((r) => {
        const u = safeUrl(r.url);
        nodes.push(el(u ? "a" : "div", u ? { class: "report", href: u, target: "_blank", rel: "noopener noreferrer" } : { class: "report" },
          el("b", {}, r.title), el("p", {}, `${r.publisher}. ${r.note}`)));
      });
      nodes.push(el("h2", { class: "section-title" }, "Top stories of the year"));
    }
    const match = FILTERS.find((f) => f[0] === state.filter)[2];
    const items = (feed[state.win] || []).filter((i) => match(i) && matchesQuery(i) && matchesTag(i));
    items.forEach((i) => nodes.push(buildCard(i)));
    if (!items.length) nodes.push(emptyState("search", "Nothing here", "Try a wider time window, another filter, or clear your search."));
  }
  list.replaceChildren(...nodes);
}

function renderControls() {
  const home = state.tab === "home";
  $("windows").hidden = !home;
  $("chips").hidden = !home;
  const searchable = state.tab !== "thoughts" || Object.keys(state.notes).length > 0;
  $("q").closest(".search").hidden = !searchable;

  if (home) {
    $("windows").replaceChildren(...WINDOWS.map(([key, label]) => el("button", {
      class: state.win === key ? "active" : "", "aria-pressed": String(state.win === key),
      onclick: () => { state.win = key; prefs.win = key; savePrefs(); render(); },
    }, label)));
    $("chips").replaceChildren(...FILTERS.map(([key, label]) => el("button", {
      class: state.filter === key ? "chip active" : "chip", "aria-pressed": String(state.filter === key),
      onclick: () => { state.filter = key; prefs.filter = key; savePrefs(); render(); },
    }, label)));
  }
  const tagbar = $("tagbar");
  const showTag = !!state.tag && state.tab !== "thoughts";
  tagbar.hidden = !showTag;
  if (showTag) {
    tagbar.replaceChildren(el("span", {}, "Showing topic"), el("button", { onclick: () => { state.tag = ""; render(); }, "aria-label": "Clear topic" }, `#${topicLabel(state.tag)}  ×`));
  }
}

function renderNav() {
  ["sideNav", "bottomNav"].forEach((id) => {
    $(id).replaceChildren(...TABS.map(([key, label, ic]) => {
      const n = key === "saved" ? state.saved.length : key === "thoughts" ? Object.keys(state.notes).length : 0;
      return el("button", {
        class: `nav-btn ${state.tab === key ? "active" : ""}`.trim(), "aria-current": state.tab === key ? "page" : null,
        onclick: () => { state.tab = key; render(); window.scrollTo(0, 0); },
      }, icon(ic, 24, state.tab === key && key === "bookmark"), el("span", {}, label), n ? el("span", { class: "count" }, String(n)) : null);
    }));
  });
}
function renderCounts() { renderNav(); renderControls(); }

function renderHeader() {
  const feed = state.feed;
  const crit = feed ? (feed.day || []).filter((i) => i.severity === "critical").length : 0;
  const badge = $("critBadge");
  badge.hidden = crit === 0 || state.tab !== "home";
  badge.textContent = `${crit} critical today`;
  $("status").textContent = feed ? `Updated ${ago(feed.generated_at)} ago` : "";
  $("title").textContent = (TABS.find((t) => t[0] === state.tab) || TABS[0])[1];
  const notice = $("notice");
  notice.hidden = !state.error || !state.feed;
  notice.textContent = state.error;

  const pill = $("newPill");
  if (state.pending) {
    pill.hidden = false;
    pill.replaceChildren(icon("up", 16), `${state.pending.fresh} new ${state.pending.fresh === 1 ? "story" : "stories"}`);
  } else {
    pill.hidden = true;
  }
}

function renderRail() {
  const rail = $("rail");
  const feed = state.feed;
  const nodes = [];
  if (feed) {
    const crit = (feed.day || []).filter((i) => i.severity === "critical").length;
    const sa = (feed.week || []).filter((i) => i.tags.includes("sa")).length;
    nodes.push(el("section", { class: "box" },
      el("h2", {}, "Right now"),
      el("div", { class: "stat" }, el("span", {}, "Critical stories today"), el("b", { class: crit ? "red" : "" }, String(crit))),
      el("div", { class: "stat" }, el("span", {}, "South African stories this week"), el("b", { class: "green" }, String(sa))),
      el("div", { class: "stat" }, el("span", {}, "Stories in the last day"), el("b", {}, String((feed.day || []).length)))));

    const counts = {};
    (feed.day || []).forEach((i) => i.tags.forEach((t) => { if (t !== "sa") counts[t] = (counts[t] || 0) + 1; }));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) {
      nodes.push(el("section", { class: "box" }, el("h2", {}, "Topics today"),
        top.map(([t, n]) => el("button", { class: "topic", onclick: () => { state.tab = "home"; state.win = "day"; state.filter = "all"; setTag(t); } },
          el("b", {}, `#${topicLabel(t)}`), el("span", {}, `${n} ${n === 1 ? "story" : "stories"}`)))));
    }
  }
  nodes.push(backupBox());
  rail.replaceChildren(...nodes);
}

function render() {
  renderHeader();
  renderNav();
  renderControls();
  renderList();
  renderRail();
}

// ---------------------------------------------------------------- theme

function effectiveTheme() {
  if (prefs.theme) return prefs.theme;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyTheme() {
  if (prefs.theme) document.documentElement.dataset.theme = prefs.theme; else delete document.documentElement.dataset.theme;
  const dark = effectiveTheme() === "dark";
  $("theme").replaceChildren(icon(dark ? "sun" : "moon", 20));
  $("theme").setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0b1220" : "#f3f6fa");
}

// ---------------------------------------------------------------- boot

$("refresh").replaceChildren(icon("refresh", 20));
$("searchIcon").replaceChildren(icon("search", 18));
$("refresh").addEventListener("click", () => refresh(true));
$("theme").addEventListener("click", () => { prefs.theme = effectiveTheme() === "dark" ? "light" : "dark"; savePrefs(); applyTheme(); });
$("newPill").addEventListener("click", applyPending);
$("importFile").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) importBackup(f); e.target.value = ""; });

let searchTimer;
$("q").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value; renderList(); }, 120);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - state.lastFetch > 60 * 1000) refresh(false);
});
setInterval(() => refresh(false), REFRESH_MS);

// Hide the header while scrolling down on phones, bring it back on the way up.
let lastY = 0;
window.addEventListener("scroll", () => {
  const y = window.scrollY;
  const d = y - lastY;
  if (Math.abs(d) < 8) return;
  $("head").classList.toggle("hide", d > 0 && y > 140);
  lastY = y;
}, { passive: true });

state.feed = load("cp.feed", null);
applyTheme();
render();
refresh(false);

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").catch(() => { /* app works without the offline shell */ });
  if (hadController) {
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  }
}
