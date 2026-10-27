#!/usr/bin/env python3
"""
CyberPulse feed builder.

Pulls security / IT / South-Africa news and public posts from free sources,
dedupes and ranks them, and writes feed.json for the app and widgets.

No API keys, no paid services, no AI calls. Runs hourly on GitHub Actions.
Optional: set NTFY_TOPIC to get real push alerts for critical items through
the free ntfy app (https://ntfy.sh).
"""
import calendar
import hashlib
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import feedparser

HERE = Path(__file__).resolve().parent
OUT = Path(os.environ.get("OUT_DIR", HERE.parent / "out"))
OUT.mkdir(parents=True, exist_ok=True)
CFG = json.loads((HERE / "sources.json").read_text(encoding="utf-8"))

NOW = datetime.now(timezone.utc)
UA = "Mozilla/5.0 (compatible; CyberPulse/1.0; personal feed reader)"
TS_FMT = "%Y-%m-%dT%H:%M:%SZ"

# ---------------------------------------------------------------- patterns

STRONG = re.compile(
    r"zero[- ]?day|actively exploited|exploited in the wild|in the wild|mass[- ]exploitation|"
    r"emergency (patch|update|fix)|out-of-band|critical (flaw|vulnerabilit|bug)|wormable",
    re.I,
)
HIGH = re.compile(
    r"vulnerabilit|\bCVE-\d{4}-\d+|exploit|malware|ransomware|phishing|botnet|\bAPT\d*\b|"
    r"espionage|breach|leak|stealer|trojan|DDoS|backdoor|patch",
    re.I,
)
BREACH = re.compile(r"breach|data leak|leaked|hacked|ransomware|cyber[- ]?attack", re.I)

SA_RE = re.compile(
    r"south africa|\bPOPIA\b|information regulator|\bSARS\b|eskom|transnet|vodacom|\bMTN\b|"
    r"telkom|capitec|\babsa\b|nedbank|standard bank|\bFNB\b|mediclinic|life healthcare|"
    r"johannesburg|cape town|pretoria|durban|gauteng|western cape|kwazulu|\bSAPS\b|"
    r"\bSABRIC\b|mzansi|\bSITA\b|\bNHLS\b|\.co\.za",
    re.I,
)

TOPICS = {
    "ransomware": r"ransomware|extortion",
    "phishing": r"phish|smish|vish|\bscam|fraud|social engineering",
    "vuln": r"vulnerabilit|\bCVE-\d|zero[- ]?day|exploit|\bpatch",
    "breach": r"breach|data leak|leaked|exposed (data|records)|stolen data|hacked",
    "malware": r"malware|trojan|stealer|botnet|backdoor|wiper|spyware",
    "apt": r"\bAPT\d*\b|nation[- ]state|state[- ]sponsored|espionage|lazarus|sandworm|typhoon",
    "ai": r"(?-i:\bAI\b)|artificial intelligence|\bLLM|machine learning|prompt injection|deepfake",
    "cloud": r"\bcloud\b|\baws\b|azure|\bgcp\b|kubernetes|misconfigur|s3 bucket",
    "ot": r"(?-i:\bICS\b)|\bSCADA\b|(?-i:\bOT\b)|industrial control|critical infrastructure|power grid|water (utility|treatment)",
    "mobile": r"android|(?-i:\biOS\b)|iphone|mobile app|sim[- ]swap",
    "privacy": r"privacy|\bGDPR\b|\bPOPIA\b|surveillance|data protection",
    "popia": r"\bPOPIA\b|information regulator|protection of personal information",
    "banking": r"\bbank|fintech|card fraud|sim[- ]swap|capitec|\babsa\b|nedbank|\bfnb\b",
    "skills": r"\bskills\b|training|graduate|learnership|bootcamp|unemployment|talent",
}
TOPICS = {k: re.compile(v, re.I) for k, v in TOPICS.items()}

STOP = set(
    "the a an of to in for and on with by from is are as at after new how what why its it be "
    "this that over into via says report reports could may will can has have been".split()
)

# South-Africa opportunity ideas. Matched against this week's stories (rule-based, no AI).
IDEAS = [
    {"id": "popia-kit", "topics": ["popia", "breach", "privacy"],
     "title": "POPIA breach-response kit for small businesses",
     "action": "Publish a free, plain-language incident-response and Information Regulator notification template pack plus a simple compliance self-check for SA SMEs. Grow it into consulting or a small SaaS."},
    {"id": "sme-ransomware", "topics": ["ransomware"],
     "title": "Ransomware readiness for SA SMEs, clinics and schools",
     "action": "Offer an affordable package: backup testing, patching baseline, MFA rollout and a one-page recovery plan. Start with 3 local pilot customers and write up the results."},
    {"id": "scam-awareness", "topics": ["phishing", "banking"],
     "title": "Scam and fraud awareness in local languages",
     "action": "Create short audio/video and WhatsApp-friendly content in isiZulu, isiXhosa, Sesotho and Afrikaans on SIM-swap, fake EFT proof and phishing. Partner with community radio and stokvels."},
    {"id": "ot-energy", "topics": ["ot"],
     "title": "OT/ICS and IoT security for energy, water and municipalities",
     "action": "Build a lightweight OT asset-and-exposure checklist for municipalities and solar/inverter installers, and learn ICS security (free CISA ICS training is a start)."},
    {"id": "disclosure", "topics": ["vuln"],
     "title": "Local coordinated vulnerability disclosure",
     "action": "Run an ethical, permission-based disclosure help desk for SA organisations that have no security contact, and publish anonymised lessons. Learn from the disclose.io model."},
    {"id": "cloud-audits", "topics": ["cloud"],
     "title": "Cloud misconfiguration audits for SA startups",
     "action": "Use free tools (Prowler, ScoutSuite) to offer low-cost AWS/Azure/GCP baseline audits with a prioritised fix list."},
    {"id": "ai-policy", "topics": ["ai"],
     "title": "AI-use policy and prompt-injection testing",
     "action": "Help SA firms write an AI acceptable-use policy and test their chatbots and copilots for prompt injection and data leakage."},
    {"id": "skills-pipeline", "topics": ["skills"],
     "title": "Community security lab and CTF nights",
     "action": "Start a free monthly study group / CTF night (campus, library or online) with a shared home-lab guide, so SA beginners get hands-on practice without paying for courses."},
]

REPORTS = CFG.get("reports", [])

# ---------------------------------------------------------------- helpers


def iso(dt):
    return dt.astimezone(timezone.utc).strftime(TS_FMT)


def parse_iso(s):
    return datetime.strptime(s, TS_FMT).replace(tzinfo=timezone.utc)


def http_get(url, timeout=25, data=None, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def clean(text, limit):
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rsplit(" ", 1)[0] + "\u2026"


def norm_url(url):
    try:
        p = urllib.parse.urlsplit(url.strip())
    except ValueError:
        return ""
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query)
         if not k.lower().startswith("utm_") and k.lower() not in {"fbclid", "gclid", "ref", "source"}]
    path = p.path.rstrip("/") if len(p.path) > 1 else p.path
    return urllib.parse.urlunsplit((p.scheme, p.netloc.lower(), path, urllib.parse.urlencode(q), ""))


def entry_time(e):
    for k in ("published_parsed", "updated_parsed"):
        t = e.get(k)
        if t:
            return datetime.fromtimestamp(calendar.timegm(t), tz=timezone.utc)
    return None


def item_id(link):
    return hashlib.sha1(link.encode("utf-8")).hexdigest()[:12]


def make_item(src, title, summary, link, published, extra_tags=None):
    title = clean(title, 200)
    summary = clean(summary, 280)
    text = f"{title} {summary}"
    tags = [t for t, rx in TOPICS.items() if rx.search(text)]
    for t in extra_tags or []:
        if t not in tags:
            tags.append(t)
    is_sa = bool(src.get("sa")) or bool(SA_RE.search(text))
    if is_sa:
        tags.insert(0, "sa")
    strong = bool(STRONG.search(text))
    high = bool(HIGH.search(text))
    base = float(src["weight"]) + (3 if strong else 0) + (1.5 if high else 0) + (2 if is_sa else 0)
    if src["category"] == "posts":
        # Public posts are unverified: show them in the Hour stream but never let them outrank reporting.
        base = float(src["weight"]) + (0.5 if high else 0)
        sev = "normal"
    elif (strong and high) or (is_sa and BREACH.search(text)):
        sev = "critical"
    elif high:
        sev = "high"
    else:
        sev = "normal"
    return {
        "id": item_id(link),
        "title": title,
        "summary": "" if summary == title else summary,
        "link": link,
        "source": src["name"],
        "category": src["category"],
        "tags": tags,
        "severity": sev,
        "base": base,
        "score": base,
        "published": iso(published),
        "also": [],
    }


# ---------------------------------------------------------------- sources


def load_feed(src):
    try:
        data = http_get(src["url"])
    except Exception as e:  # network errors must not kill the run
        return src["name"], [], f"{type(e).__name__}: {e}"
    parsed = feedparser.parse(data)
    items = []
    for e in parsed.entries[: src.get("max", 40)]:
        link = norm_url(e.get("link", ""))
        title = e.get("title", "") or ""
        ts = entry_time(e)
        if not link or not title.strip() or not ts:
            continue
        ts = min(ts, NOW)
        if NOW - ts > timedelta(days=14):
            continue
        summary = e.get("summary", "") or ""
        s = dict(src)
        if src.get("per_entry_source"):
            pub = e.get("source")
            if pub and pub.get("title"):
                s["name"] = pub["title"]
                title = re.sub(r"\s+[-\u2013]\s+" + re.escape(pub["title"]) + r"$", "", title)
            summary = ""  # Google News summaries just repeat the headline
        items.append(make_item(s, title, summary, link, ts))
    return src["name"], items, None


def load_kev():
    try:
        data = json.loads(http_get(CFG["kev_url"]))
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"
    items = []
    for v in data.get("vulnerabilities", []):
        try:
            d = datetime.strptime(v["dateAdded"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue
        age = (NOW - d).days
        ransom = v.get("knownRansomwareCampaignUse") == "Known"
        if age > 365 or (age > 30 and not ransom):
            continue
        cve = v.get("cveID", "")
        src = {"name": "CISA KEV", "category": "vuln", "weight": 8 + (2 if ransom else 0)}
        it = make_item(
            src,
            f"Actively exploited: {cve} \u2013 {v.get('vendorProject', '')} {v.get('product', '')}".strip(),
            f"{v.get('vulnerabilityName', '')}. {v.get('shortDescription', '')}",
            f"https://nvd.nist.gov/vuln/detail/{cve}",
            min(NOW, d + timedelta(hours=12)),
            extra_tags=["vuln"] + (["ransomware"] if ransom else []),
        )
        it["severity"] = "critical" if age <= 30 else "high"
        items.append(it)
    return items, None


# ---------------------------------------------------------------- dedupe / history


def toks(title):
    return {w for w in re.findall(r"[a-z0-9]{3,}", title.lower()) if w not in STOP}


def dedupe(items):
    """Merge duplicate stories. Keeps the highest-base copy and lists the other sources."""
    items = sorted(items, key=lambda i: i["base"], reverse=True)
    kept, kept_toks = [], []
    for it in items:
        t = toks(it["title"])
        when = parse_iso(it["published"])
        dup = None
        for k, kt in zip(kept, kept_toks):
            if k["link"] == it["link"]:
                dup = k
                break
            if len(t) >= 4 and len(kt) >= 4 and abs((parse_iso(k["published"]) - when).days) < 3:
                if len(t & kt) / len(t | kt) >= 0.6:
                    dup = k
                    break
        if dup is None:
            kept.append(it)
            kept_toks.append(t)
        else:
            for name in [it["source"]] + it["also"]:
                if name != dup["source"] and name not in dup["also"]:
                    dup["also"].append(name)
    for k in kept:
        k["score"] = round(k["base"] + min(len(k["also"]), 3), 2)
    return kept


def load_history():
    p = OUT / "history.json"
    if not p.exists():
        return {}
    try:
        return {i["id"]: i for i in json.loads(p.read_text(encoding="utf-8"))}
    except (ValueError, KeyError):
        return {}


def prune(items):
    """Keep 14 days in full. Older: only the top 10 per day, up to 400 days."""
    out, by_day = [], {}
    for it in items:
        age = NOW - parse_iso(it["published"])
        if age <= timedelta(days=14):
            out.append(it)
        elif age <= timedelta(days=400):
            by_day.setdefault(it["published"][:10], []).append(it)
    for day_items in by_day.values():
        day_items.sort(key=lambda i: i["score"], reverse=True)
        out.extend(day_items[:10])
    return out


def public(it):
    d = {k: v for k, v in it.items() if k != "base"}
    d["also"] = list(it["also"])
    return d


# ---------------------------------------------------------------- views


def build_sa_ideas(week_items):
    sa_items = [i for i in week_items if "sa" in i["tags"]]
    scored = []
    for idea in IDEAS:
        topics = set(idea["topics"])
        hits_sa = sorted((i for i in sa_items if topics & set(i["tags"])), key=lambda i: i["score"], reverse=True)
        hits_all = sorted((i for i in week_items if topics & set(i["tags"])), key=lambda i: i["score"], reverse=True)
        weight = 3 * len(hits_sa) + len(hits_all)
        ev = (hits_sa or hits_all or [None])[0]
        scored.append((weight, {
            "id": idea["id"],
            "title": idea["title"],
            "action": idea["action"],
            "why": (f"{len(hits_sa)} South African and {len(hits_all)} total stories this week touch this area."
                    if weight else "Evergreen idea (no matching stories this week)."),
            "evidence_title": ev["title"] if ev else "",
            "evidence_link": ev["link"] if ev else "",
            "signal": len(hits_sa),
        }))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [i for w, i in scored[:5]]


def build_windows(items):
    def within(hours):
        cutoff = NOW - timedelta(hours=hours)
        return [i for i in items if parse_iso(i["published"]) >= cutoff]

    by_time = lambda i: i["published"]
    by_score = lambda i: (i["score"], i["published"])
    hour = sorted(within(3), key=by_time, reverse=True)[:40]
    day = sorted(within(24), key=by_score, reverse=True)[:60]
    week_all = within(24 * 7)
    week = sorted(week_all, key=by_score, reverse=True)[:80]
    year = sorted(within(24 * 365), key=by_score, reverse=True)[:120]
    return hour, day, week, year, week_all


# ---------------------------------------------------------------- ntfy push (optional)


def ascii_header(s):
    return s.encode("ascii", "ignore").decode()[:120] or "CyberPulse alert"


def push_alerts(items):
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    p = OUT / "notified.json"
    first_run = not p.exists()
    try:
        seen = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    except ValueError:
        seen = {}
    cutoff = NOW - timedelta(hours=3)
    fresh = [i for i in items
             if i["severity"] == "critical" and i["category"] != "posts"
             and parse_iso(i["published"]) >= cutoff and i["id"] not in seen]
    fresh.sort(key=lambda i: i["score"], reverse=True)
    sent = 0
    for it in fresh:
        seen[it["id"]] = iso(NOW)
        if first_run or not topic or sent >= 5:
            continue  # first run only records, so you aren't flooded
        try:
            body = (it["summary"] or it["title"]).encode("utf-8")
            http_get(
                f"https://ntfy.sh/{urllib.parse.quote(topic)}",
                data=body,
                headers={
                    "Title": ascii_header(it["title"]),
                    "Click": it["link"],
                    "Priority": "high",
                    "Tags": "rotating_light" + (",flag-za" if "sa" in it["tags"] else ""),
                },
            )
            sent += 1
        except Exception as e:
            print(f"ntfy failed: {e}", file=sys.stderr)
    seen = {k: v for k, v in seen.items() if parse_iso(v) > NOW - timedelta(days=14)}
    p.write_text(json.dumps(seen), encoding="utf-8")
    return sent


# ---------------------------------------------------------------- main


def run():
    failed, ok = [], []
    new_items = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for name, items, err in ex.map(load_feed, CFG["feeds"]):
            if err:
                failed.append(f"{name}: {err}")
            else:
                ok.append(name)
                new_items.extend(items)
    kev, kev_err = load_kev()
    if kev_err:
        failed.append(f"CISA KEV: {kev_err}")
    else:
        ok.append("CISA KEV")
        new_items.extend(kev)

    print(f"sources ok: {len(ok)}, failed: {len(failed)}, new items: {len(new_items)}")
    for f in failed:
        print("  FAILED", f, file=sys.stderr)

    if not new_items:
        print("nothing fetched; keeping previous feed", file=sys.stderr)
        sys.exit(0 if (OUT / "feed.json").exists() else 1)

    history = load_history()
    for it in new_items:
        old = history.get(it["id"])
        if old:
            it["also"] = sorted(set(it["also"]) | set(old.get("also", [])))
        history[it["id"]] = it

    recent_cut = NOW - timedelta(days=10)
    recent = [i for i in history.values() if parse_iso(i["published"]) >= recent_cut]
    older = [i for i in history.values() if parse_iso(i["published"]) < recent_cut]
    merged = prune(dedupe(recent) + older)

    hour, day, week, year, week_all = build_windows(merged)
    sent = push_alerts(merged)

    feed = {
        "generated_at": iso(NOW),
        "hour": [public(i) for i in hour],
        "day": [public(i) for i in day],
        "week": [public(i) for i in week],
        "year": [public(i) for i in year],
        "sa_ideas": build_sa_ideas(week_all),
        "reports": REPORTS,
        "stats": {"sources_ok": len(ok), "sources_failed": [f.split(":")[0] for f in failed], "history_items": len(merged)},
    }
    (OUT / "feed.json").write_text(json.dumps(feed, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "history.json").write_text(json.dumps(merged, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote feed: hour={len(hour)} day={len(day)} week={len(week)} year={len(year)} ideas={len(feed['sa_ideas'])} pushed={sent}")


if __name__ == "__main__":
    run()
