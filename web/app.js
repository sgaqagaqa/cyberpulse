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
  ["vulns", "Vulns", (i) => i.category === "vuln" || i.tags.includes("vuln")],
  ["sa", "South Africa", (i) => i.tags.includes("sa")],
  ["industry", "IT News", (i) => i.category === "industry" || i.category === "news"],
  ["posts", "Posts", (i) => i.category === "posts"],
];

const state = {
  feed: null,
  tab: "feed",
  win: "day",
  filter: "all",
  saved: load("cp.saved", []),
  error: "",
  loading: false,
  lastFetch: 0,
};

// ---------------------------------------------------------------- helpers

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* storage full or blocked: the app still works */
  }
}

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

function safeUrl(u) {
  return /^https?:\/\//i.test(u || "") ? u : null;
}

function ago(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- data

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $("refresh").classList.add("spin");
  try {
    const res = await fetch(`${FEED_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.feed = await res.json();
    state.error = "";
    state.lastFetch = Date.now();
    store("cp.feed", state.feed);
  } catch (e) {
    const cached = load("cp.feed", null);
    if (cached) state.feed = cached;
    state.error = cached
      ? "Offline or feed unavailable. Showing your last saved feed."
      : "Feed not available yet. Run the GitHub Action once, then reload.";
  } finally {
    state.loading = false;
    $("refresh").classList.remove("spin");
    render();
  }
}

function isSaved(item) {
  return state.saved.some((s) => s.id === item.id);
}

function toggleSave(item) {
  const i = state.saved.findIndex((s) => s.id === item.id);
  if (i >= 0) state.saved.splice(i, 1);
  else state.saved.unshift(item);
  store("cp.saved", state.saved);
  render();
}

// ---------------------------------------------------------------- views

function itemCard(item) {
  const url = safeUrl(item.link);
  const title = url
    ? el("a", { class: "title", href: url, target: "_blank", rel: "noopener noreferrer" }, item.title)
    : el("span", { class: "title" }, item.title);

  const meta = el("div", { class: "meta" },
    el("span", {}, `${item.source} · ${ago(item.published)}`),
    item.also && item.also.length ? el("span", {}, `+${item.also.length} more`) : null,
    (item.tags || []).slice(0, 3).map((t) => el("span", { class: t === "sa" ? "tag sa" : "tag" }, t)),
  );

  const on = isSaved(item);
  return el("article", { class: "card" },
    el("span", { class: `dot ${item.severity}`, title: item.severity }),
    el("div", {}, title, item.summary ? el("p", { class: "summary" }, item.summary) : null, meta),
    el("button", {
      class: on ? "save on" : "save",
      "aria-label": on ? "Remove from saved" : "Save",
      onclick: () => toggleSave(item),
    }, on ? "★" : "☆"),
  );
}

function ideaCard(idea) {
  const url = safeUrl(idea.evidence_link);
  return el("article", { class: "card idea" },
    el("div", {},
      el("h3", {}, idea.title),
      el("p", {}, idea.action),
      el("p", { class: "why" }, idea.why),
      url && idea.evidence_title
        ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, `Evidence: ${idea.evidence_title}`)
        : null,
    ),
  );
}

function reportCard(r) {
  const url = safeUrl(r.url);
  return el("article", { class: "card report" },
    el("div", {},
      url ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, r.title) : el("span", {}, r.title),
      el("p", {}, `${r.publisher} · ${r.note}`),
    ),
  );
}

function empty(text) {
  return el("div", { class: "empty" }, text);
}

function renderControls() {
  const showControls = state.tab === "feed";
  $("controls").hidden = !showControls;
  if (!showControls) return;

  $("windows").replaceChildren(...WINDOWS.map(([key, label]) =>
    el("button", {
      class: state.win === key ? "active" : "",
      onclick: () => { state.win = key; render(); },
    }, label)));

  $("chips").replaceChildren(...FILTERS.map(([key, label]) =>
    el("button", {
      class: state.filter === key ? "chip active" : "chip",
      onclick: () => { state.filter = key; render(); },
    }, label)));
}

function renderList() {
  const list = $("list");
  const feed = state.feed;
  const nodes = [];

  if (state.tab === "saved") {
    if (!state.saved.length) nodes.push(empty("Nothing saved yet. Tap the star on any story."));
    else state.saved.forEach((i) => nodes.push(itemCard(i)));
  } else if (!feed) {
    nodes.push(empty(state.loading ? "Loading…" : "No feed yet."));
  } else if (state.tab === "sa") {
    if (feed.sa_ideas && feed.sa_ideas.length) {
      nodes.push(el("div", { class: "section-title" }, "Ideas to move SA's IT & cyber scene forward"));
      feed.sa_ideas.forEach((i) => nodes.push(ideaCard(i)));
    }
    nodes.push(el("div", { class: "section-title" }, "South African stories this week"));
    const stories = (feed.week || []).filter((i) => i.tags.includes("sa"));
    if (!stories.length) nodes.push(empty("No South African stories in the last 7 days."));
    stories.forEach((i) => nodes.push(itemCard(i)));
  } else {
    if (state.win === "year" && feed.reports && feed.reports.length) {
      nodes.push(el("div", { class: "section-title" }, "Annual reports worth reading"));
      feed.reports.forEach((r) => nodes.push(reportCard(r)));
      nodes.push(el("div", { class: "section-title" }, "Top stories (fills up as history builds)"));
    }
    const match = FILTERS.find((f) => f[0] === state.filter)[2];
    const items = (feed[state.win] || []).filter(match);
    if (!items.length) nodes.push(empty("Nothing here yet. Try a wider window or another filter."));
    items.forEach((i) => nodes.push(itemCard(i)));
  }
  list.replaceChildren(...nodes);
}

function renderHeader() {
  const feed = state.feed;
  const crit = feed ? (feed.day || []).filter((i) => i.severity === "critical").length : 0;
  const badge = $("critBadge");
  badge.hidden = crit === 0;
  badge.textContent = `${crit} critical`;
  $("status").textContent = feed ? `Updated ${ago(feed.generated_at)}` : "";

  const notice = $("notice");
  notice.hidden = !state.error;
  notice.textContent = state.error;

  document.querySelectorAll("#tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === state.tab));
}

function render() {
  renderHeader();
  renderControls();
  renderList();
}

// ---------------------------------------------------------------- boot

document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => { state.tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));
$("refresh").addEventListener("click", refresh);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - state.lastFetch > 60 * 1000) refresh();
});
setInterval(refresh, REFRESH_MS);

state.feed = load("cp.feed", null);
render();
refresh();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* app works without offline shell */ });
}
