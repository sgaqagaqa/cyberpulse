// CyberPulse widget for the free Scriptable app (iPhone lock screen + home screen).
// Setup: open Scriptable -> + (new script) -> paste this whole file -> name it "CyberPulse".
// Then add a Scriptable widget (lock screen or home screen) and choose the "CyberPulse" script.
//
// 1) Put your GitHub username below. Nothing else needs changing.
const GITHUB_USER = "YOUR_GITHUB_USERNAME";
const REPO = "cyberpulse";

const FEED_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${REPO}/data/feed.json`;
const REFRESH_MINUTES = 30; // a request; iOS decides the real timing
const CACHE_FILE = "cyberpulse-feed.json";

const COLORS = {
  critical: new Color("#ff5a52"),
  high: new Color("#ffa63d"),
  normal: new Color("#4c8dff"),
};

// ---------------------------------------------------------------- data

async function getFeed() {
  const fm = FileManager.local();
  const path = fm.joinPath(fm.cacheDirectory(), CACHE_FILE);
  if (GITHUB_USER !== "YOUR_GITHUB_USERNAME") {
    try {
      const req = new Request(FEED_URL);
      req.timeoutInterval = 15;
      req.headers = { "Cache-Control": "no-cache" };
      const feed = await req.loadJSON();
      if (feed && feed.day) {
        fm.writeString(path, JSON.stringify(feed));
        return feed;
      }
    } catch (e) {
      // fall through to the cached copy
    }
    if (fm.fileExists(path)) {
      try { return JSON.parse(fm.readString(path)); } catch (e) { /* ignore */ }
    }
  }
  return sampleFeed();
}

function sampleFeed() {
  const now = new Date().toISOString();
  const item = (title, severity) => ({
    id: title, title, severity, source: "CyberPulse", link: "https://github.com",
    category: "news", tags: [], score: 1, published: now,
  });
  const items = [
    item("Put your GitHub username in the script to go live", "high"),
    item("Sample: critical zero-day actively exploited", "critical"),
    item("Sample: SA retailer reports data breach", "critical"),
  ];
  return { generated_at: now, hour: items, day: items, week: items, year: items };
}

// Same idea as the app: fresh + serious first, then the day's top stories.
function headlines(feed, limit) {
  const rank = (i) => (i.severity === "critical" ? 2 : i.severity === "high" ? 1 : 0);
  const seen = new Set();
  const now = Date.now();
  const fresh = [...(feed.hour || []), ...(feed.day || [])]
    .filter((i) => i.category !== "posts" && now - new Date(i.published).getTime() < 12 * 3600 * 1000)
    .filter((i) => !seen.has(i.id) && seen.add(i.id))
    .sort((a, b) => rank(b) - rank(a) || new Date(b.published) - new Date(a.published));
  const fill = [...(feed.day || [])]
    .sort((a, b) => b.score - a.score)
    .filter((i) => !seen.has(i.id) && seen.add(i.id));
  return [...fresh, ...fill].slice(0, limit);
}

function ago(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const colorFor = (item) => COLORS[item.severity] || COLORS.normal;

// ---------------------------------------------------------------- widgets

function buildLockScreen(feed, family) {
  const w = new ListWidget();
  const top = headlines(feed, 1)[0];
  const critical = (feed.day || []).filter((i) => i.severity === "critical").length;

  if (family === "accessoryInline") {
    w.addText(top ? `${top.severity === "critical" ? "⚠︎ " : ""}${top.title}` : "CyberPulse");
  } else if (family === "accessoryCircular") {
    const t = w.addText(String(critical));
    t.font = Font.boldSystemFont(22);
    t.centerAlignText();
    const l = w.addText("critical");
    l.font = Font.systemFont(9);
    l.centerAlignText();
  } else {
    // accessoryRectangular
    const head = w.addText(top && top.severity === "critical" ? "⚠︎ CRITICAL" : "CyberPulse");
    head.font = Font.boldSystemFont(11);
    if (top) {
      const t = w.addText(top.title);
      t.font = Font.systemFont(12);
      t.lineLimit = 2;
      const s = w.addText(`${top.source} · ${ago(top.published)}`);
      s.font = Font.systemFont(10);
      s.textOpacity = 0.7;
    }
  }
  if (top) w.url = top.link;
  return w;
}

function buildHome(feed, family) {
  const w = new ListWidget();
  w.backgroundColor = Color.dynamic(new Color("#f4f6f9"), new Color("#0b0f14"));
  w.setPadding(12, 14, 12, 14);

  const small = family === "small";
  const count = small ? 1 : family === "large" || family === "extraLarge" ? 6 : 3;
  const items = headlines(feed, count);
  const critical = (feed.day || []).filter((i) => i.severity === "critical").length;

  if (small) {
    const top = items[0];
    if (top) {
      const badge = w.addText(top.severity === "critical" ? "CRITICAL" : top.severity === "high" ? "HIGH" : "LATEST");
      badge.font = Font.boldSystemFont(10);
      badge.textColor = colorFor(top);
      w.addSpacer(3);
      const t = w.addText(top.title);
      t.font = Font.boldSystemFont(14);
      t.lineLimit = 5;
      w.addSpacer();
      const s = w.addText(`${top.source} · ${ago(top.published)}`);
      s.font = Font.systemFont(10);
      s.textOpacity = 0.6;
      w.url = top.link;
    } else {
      w.addText("No stories yet");
    }
    return w;
  }

  const header = w.addStack();
  header.centerAlignContent();
  const name = header.addText("CyberPulse");
  name.font = Font.boldSystemFont(12);
  header.addSpacer();
  if (critical > 0) {
    const c = header.addText(`${critical} critical today`);
    c.font = Font.boldSystemFont(10);
    c.textColor = COLORS.critical;
  }
  w.addSpacer(6);

  items.forEach((item) => {
    const row = w.addStack();
    row.topAlignContent();
    row.spacing = 6;
    row.url = item.link;
    const dot = row.addText("●");
    dot.font = Font.systemFont(8);
    dot.textColor = colorFor(item);
    const col = row.addStack();
    col.layoutVertically();
    const t = col.addText(item.title);
    t.font = Font.systemFont(13);
    t.lineLimit = 2;
    const s = col.addText(`${item.source} · ${ago(item.published)}`);
    s.font = Font.systemFont(10);
    s.textOpacity = 0.6;
    w.addSpacer(5);
  });
  w.addSpacer();
  return w;
}

// ---------------------------------------------------------------- run

const feed = await getFeed();
const family = config.widgetFamily || "medium"; // "medium" preview when run inside Scriptable
const lock = ["accessoryInline", "accessoryCircular", "accessoryRectangular"].includes(family);
const widget = lock ? buildLockScreen(feed, family) : buildHome(feed, family);
widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
