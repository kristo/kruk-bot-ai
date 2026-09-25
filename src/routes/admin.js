/**
 * Prosty podgląd historii rozmów dla Wiktorii/Damiana — od Krzysztofa, 13.09.2026. Zamiast
 * proszenia o ręczne przeszukanie logów Railway za każdym razem, można to teraz sprawdzić
 * samodzielnie pod jednym zakładkowanym linkiem.
 *
 * Zabezpieczenie: pojedynczy token w query string (ADMIN_TOKEN) — nie ma tu systemu kont,
 * to najprostsze rozwiązanie adekwatne do wagi tych danych (transkrypty rozmów o wizytach
 * fryzjerskich, nie dane wrażliwe/finansowe). Link z tokenem wystarczy zapisać w zakładce.
 *
 * Dashboard i wyszukiwanie — od Krzysztofa, 24.09.2026: dotąd "co się dziś działo" trzeba było
 * ręcznie rekonstruować z logów Railway (patrz historia czatu), a płaska lista ostatnich N
 * rozmów/zgłoszeń nie dawała żadnego sposobu, żeby znaleźć konkretny numer czy frazę.
 */
const express = require("express");
const {
  getRecentCalls,
  getCallTurns,
  countCallsSince,
  getCallbackRequests,
  getCallbackCategoryCountsSince,
  countPendingCallbacks,
  setCallbackResolved,
  logSmsMessage,
  getSmsThread,
  getSmsConversations,
  countSmsMessagesSince,
  countAwaitingSmsReplies,
} = require("../services/callLog");
const { getTwilioClient, normalizePhoneNumber } = require("../services/notify");

const router = express.Router();

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function checkToken(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).send("Panel administracyjny nie jest skonfigurowany (brak ADMIN_TOKEN w zmiennych środowiskowych).");
  }
  if ((req.query.token || "") !== expected) {
    return res.status(403).send("Brak dostępu — nieprawidłowy albo brakujący token w linku.");
  }
  next();
}

router.use(checkToken);

const RAVEN_MARK =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 15C5 9 9.5 5 15.5 5c1.8 0 3 .6 3 1.8 0 1.3-1.4 1.9-3 2.2l-2.4.5 4.7 2.2c1.3.6 2.2 1.3 2.2 2.4 0 1.4-1.6 2.1-3.4 1.7l-3-.7 1.6 3.3c.5 1-.1 2.1-1.3 2.1-.7 0-1.2-.4-1.6-1.1L10.6 15l-2.9 1.8c-1 .6-2.2.3-2.6-.7-.3-.8 0-1.6.9-2.1l2.6-1.5L3 15Z" fill="currentColor"/></svg>';

function pageShell(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,340..600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
  :root {
    --bg: #F3F5F6; --surface: #FFFFFF; --text: #14151A; --text-muted: #565B66;
    --border: #E1E4EA; --accent: #1F6B74; --accent-contrast: #FFFFFF; --accent-soft: #DCEEF0;
    --gold: #9C6D26; --gold-soft: #F5E6C8; --lang: #4C5FD9; --lang-soft: #E1E4FB;
    --neutral-soft: #E7E8EC; --danger: #B4501E; --shadow: 0 1px 2px rgba(20,21,26,.05);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #121319; --surface: #1B1D25; --text: #F1F1EE; --text-muted: #9BA0AC;
      --border: #2A2D38; --accent: #4FC2CC; --accent-contrast: #0B1416; --accent-soft: #1D3A3E;
      --gold: #E8B959; --gold-soft: #3A2E14; --lang: #8D9AFF; --lang-soft: #262A4A;
      --neutral-soft: #262832; --danger: #E08659; --shadow: 0 1px 2px rgba(0,0,0,.35);
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg: #121319; --surface: #1B1D25; --text: #F1F1EE; --text-muted: #9BA0AC;
    --border: #2A2D38; --accent: #4FC2CC; --accent-contrast: #0B1416; --accent-soft: #1D3A3E;
    --gold: #E8B959; --gold-soft: #3A2E14; --lang: #8D9AFF; --lang-soft: #262A4A;
    --neutral-soft: #262832; --danger: #E08659; --shadow: 0 1px 2px rgba(0,0,0,.35);
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: "IBM Plex Sans", -apple-system, sans-serif; font-size: 15px; line-height: 1.5; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 20px 64px; }
  h1, h2 { font-family: "Fraunces", Georgia, serif; font-weight: 480; margin: 0; }
  h1 { font-size: 1.6rem; }
  h2.day-heading { font-size: 1.05rem; font-weight: 600; font-family: "IBM Plex Sans", sans-serif; margin: 32px 0 8px; color: var(--text-muted); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .mono { font-family: "IBM Plex Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }
  .muted { color: var(--text-muted); }

  header.top { position: sticky; top: env(safe-area-inset-top,0px); z-index: 10; background: color-mix(in srgb, var(--bg) 90%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); margin-bottom: 28px; }
  .top-row { max-width: 1080px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 8px; font-family: "Fraunces", serif; font-weight: 600; font-size: 1.05rem; color: var(--text); }
  nav.tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  nav.tabs a { display: inline-flex; align-items: center; gap: 6px; padding: 7px 13px; border-radius: 8px; font-size: 0.88rem; font-weight: 500; color: var(--text-muted); text-decoration: none; }
  nav.tabs a:hover { background: var(--neutral-soft); text-decoration: none; }
  nav.tabs a.active { background: var(--accent); color: var(--accent-contrast); }

  table { border-collapse: collapse; width: 100%; margin-top: 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  td, th { padding: 10px 14px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
  th { background: var(--neutral-soft); font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: color-mix(in srgb, var(--accent) 4%, transparent); }
  tr.resolved { opacity: 0.5; }
  tr.resolved td { text-decoration: line-through; }

  .pill { display: inline-block; padding: 3px 10px; border-radius: 100px; font-size: 0.76rem; font-weight: 600; white-space: nowrap; }
  .pill-zapis { background: var(--accent-soft); color: var(--accent); }
  .pill-late { background: var(--gold-soft); color: var(--gold); }
  .pill-inne { background: var(--neutral-soft); color: var(--text-muted); }
  .pill-lang { background: var(--lang-soft); color: var(--lang); }

  form.resolve-form { margin: 0; }
  .msg { max-width: 34rem; padding: 8px 12px; margin: 6px 0; border-radius: 12px; white-space: pre-wrap; font-size: 0.92rem; }
  .msg.in { background: var(--surface); border: 1px solid var(--border); }
  .msg.out { background: var(--accent-soft); margin-left: auto; }
  .msg .meta { display: block; font-size: 0.74em; color: var(--text-muted); margin-top: 4px; }
  .thread { display: flex; flex-direction: column; margin-top: 1rem; }
  .reply-box { margin-top: 1.5rem; }
  .reply-box textarea { width: 100%; max-width: 34rem; min-height: 5rem; padding: 10px; font: inherit; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); }
  .reply-box button { margin-top: 8px; }
  .awaiting { font-weight: 600; color: var(--danger); }

  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 8px; font-size: 0.86rem; font-weight: 600; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font-family: inherit; }
  .btn:hover { border-color: var(--accent); }
  .btn-accent { background: var(--accent); color: var(--accent-contrast); border-color: var(--accent); }

  form.search { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
  form.search input[type="text"] { flex: 1; min-width: 200px; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; }
  form.search input[type="text"]:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 18px; }
  @media (max-width: 760px) { .stat-grid { grid-template-columns: 1fr 1fr; } }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; box-shadow: var(--shadow); }
  .stat-card .num { font-family: "IBM Plex Mono", monospace; font-size: 1.7rem; font-weight: 600; }
  .stat-card .label { font-size: 0.8rem; color: var(--text-muted); margin-top: 2px; }
  .stat-card.flag .num { color: var(--danger); }
  .stat-card a { display: block; }

  .cat-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
  .cat-row .pill b { margin-left: 6px; font-family: "IBM Plex Mono", monospace; }

  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 32px; }
  @media (max-width: 760px) { .split { grid-template-columns: 1fr; } }
  .split h2 { font-size: 1rem; margin-bottom: 4px; }
  .mini-list { list-style: none; margin: 10px 0 0; padding: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .mini-list li { padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 0.88rem; display: flex; justify-content: space-between; gap: 12px; }
  .mini-list li:last-child { border-bottom: none; }
  .mini-list .t { color: var(--text-muted); font-size: 0.78rem; flex: none; }
  .empty-note { padding: 14px; font-size: 0.88rem; color: var(--text-muted); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin-top: 10px; }
</style>
</head><body>${body}</body></html>`;
}

// Polska odmiana przez liczebniki — "1 rozmowa", "2 rozmowy", "5 rozmów".
function polishForm(count, [one, few, many]) {
  if (count === 1) return one;
  const lastTwo = count % 100;
  const last = count % 10;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

const CATEGORY_PILL_CLASS = {
  ZAPIS: "pill-zapis",
  "SPÓŹNIENIE": "pill-late",
  EN: "pill-lang",
  "JĘZYK?": "pill-lang",
};
function categoryPill(category) {
  const cls = CATEGORY_PILL_CLASS[category] || "pill-inne";
  return `<span class="pill ${cls}">${escapeHtml(category)}</span>`;
}

function navBar(token, active) {
  const tab = (href, label, key) =>
    `<a href="${href}?token=${encodeURIComponent(token)}" class="${key === active ? "active" : ""}">${label}</a>`;
  const pending = countPendingCallbacks();
  const awaiting = countAwaitingSmsReplies();
  const callbacksLabel = pending > 0 ? `Do oddzwonienia (${pending})` : "Do oddzwonienia";
  const smsLabel = awaiting > 0 ? `SMS-y (${awaiting})` : "SMS-y";
  return `<nav class="tabs">${tab("/admin", "Panel", "dashboard")}${tab(
    "/admin/calls",
    "Rozmowy",
    "calls"
  )}${tab("/admin/callbacks", callbacksLabel, "callbacks")}${tab("/admin/sms", smsLabel, "sms")}</nav>`;
}

function pageHeader(token, active) {
  return `<header class="top"><div class="top-row"><span class="brand">${RAVEN_MARK}Kruk AI</span>${navBar(token, active)}</div></header>`;
}

function searchForm(action, token, q, placeholder, extraFields = "") {
  return `<form class="search" method="get" action="${action}">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    ${extraFields}
    <input type="text" name="q" value="${escapeHtml(q || "")}" placeholder="${escapeHtml(placeholder)}">
    <button type="submit" class="btn">Szukaj</button>
    ${q ? `<a class="btn" href="${action}?token=${encodeURIComponent(token)}">Wyczyść</a>` : ""}
  </form>`;
}

// Data/godzina w czasie warszawskim — zapisane created_at to UTC (patrz callLog.js), a właściciele
// salonu myślą o "dziś"/"wczoraj" w czasie lokalnym, nie UTC.
function warsawDayLabel(isoString) {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(isoString));
}

function warsawTimeLabel(isoString) {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoString));
}

// Przesunięcie Warszawy względem UTC w minutach, w danej chwili — zmienia się w roku (CET/CEST),
// więc nie da się użyć stałej wartości. Sztuczka: sformatuj "teraz" w strefie warszawskiej i
// odczytaj części składowe TAK, jakby były UTC — różnica względem prawdziwego UTC to offset.
function warsawUtcOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Warsaw",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

// Północ "dziś" w Warszawie, jako ISO w UTC — granica dla statystyk dashboardu.
function warsawStartOfTodayIso(now = new Date()) {
  const offsetMin = warsawUtcOffsetMinutes(now);
  const warsawNow = new Date(now.getTime() + offsetMin * 60000);
  const midnightUtcInstant =
    Date.UTC(warsawNow.getUTCFullYear(), warsawNow.getUTCMonth(), warsawNow.getUTCDate()) - offsetMin * 60000;
  return new Date(midnightUtcInstant).toISOString();
}

// Lista jest już posortowana po created_at malejąco (patrz getCallbackRequests) — dni zmieniają
// się więc w ciągłych blokach, wystarczy jeden przebieg bez ponownego sortowania.
function groupByWarsawDay(items) {
  const groups = [];
  let current = null;
  for (const item of items) {
    const label = warsawDayLabel(item.created_at);
    if (!current || current.label !== label) {
      current = { label, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

router.get("/", (req, res) => {
  const token = req.query.token;
  const todayIso = warsawStartOfTodayIso();

  const callsToday = countCallsSince(todayIso);
  const smsToday = countSmsMessagesSince(todayIso);
  const pendingCallbacks = countPendingCallbacks();
  const awaitingSms = countAwaitingSmsReplies();
  const categoryCounts = getCallbackCategoryCountsSince(todayIso);
  const recentCalls = getRecentCalls(6);
  const openCallbacks = getCallbackRequests({ includeResolved: false, limit: 6 });

  const statCard = (num, label, href, flag) =>
    `<div class="stat-card${flag ? " flag" : ""}"><a href="${href}?token=${encodeURIComponent(token)}"><span class="num mono">${num}</span><span class="label">${label}</span></a></div>`;

  const catRow = categoryCounts.length
    ? `<div class="cat-row">${categoryCounts.map((c) => `<span class="pill ${CATEGORY_PILL_CLASS[c.category] || "pill-inne"}">${escapeHtml(c.category)}<b>${c.count}</b></span>`).join("")}</div>`
    : `<p class="muted" style="margin-top:14px;">Brak zgłoszeń dzisiaj.</p>`;

  const callsList = recentCalls.length
    ? `<ul class="mini-list">${recentCalls
        .map(
          (c) =>
            `<li><a href="/admin/calls/${encodeURIComponent(c.call_sid)}?token=${encodeURIComponent(token)}">${escapeHtml(c.from_number || "nieznany numer")}</a><span class="t mono">${warsawTimeLabel(c.started_at)}</span></li>`
        )
        .join("")}</ul>`
    : `<p class="empty-note">Brak rozmów.</p>`;

  const callbacksList = openCallbacks.length
    ? `<ul class="mini-list">${openCallbacks
        .map(
          (r) =>
            `<li>${categoryPill(r.category)} <span class="mono" style="margin-left:8px;">${escapeHtml(r.client_phone || "brak numeru")}</span><span class="t mono">${warsawTimeLabel(r.created_at)}</span></li>`
        )
        .join("")}</ul>`
    : `<p class="empty-note">Brak nieodhaczonych zgłoszeń. 🎉</p>`;

  res.type("html").send(
    pageShell(
      "Panel — Kruk AI",
      `${pageHeader(token, "dashboard")}
       <div class="wrap">
         <h1>Dziś, ${escapeHtml(warsawDayLabel(new Date().toISOString()))}</h1>
         <div class="stat-grid">
           ${statCard(callsToday, polishForm(callsToday, ["rozmowa", "rozmowy", "rozmów"]) + " dziś", "/admin/calls", false)}
           ${statCard(smsToday, polishForm(smsToday, ["SMS dziś", "SMS-y dziś", "SMS-ów dziś"]), "/admin/sms", false)}
           ${statCard(pendingCallbacks, "do oddzwonienia", "/admin/callbacks", pendingCallbacks > 0)}
           ${statCard(awaitingSms, "czeka na odpowiedź SMS", "/admin/sms", awaitingSms > 0)}
         </div>
         <h2 class="day-heading" style="margin-top:36px;">Zgłoszenia dziś, wg kategorii</h2>
         ${catRow}
         <div class="split">
           <div>
             <h2>Ostatnie rozmowy</h2>
             ${callsList}
             <p style="margin-top:10px;"><a href="/admin/calls?token=${encodeURIComponent(token)}">wszystkie rozmowy &rarr;</a></p>
           </div>
           <div>
             <h2>Najświeższe zgłoszenia do oddzwonienia</h2>
             ${callbacksList}
             <p style="margin-top:10px;"><a href="/admin/callbacks?token=${encodeURIComponent(token)}">wszystkie zgłoszenia &rarr;</a></p>
           </div>
         </div>
       </div>`
    )
  );
});

router.get("/calls", (req, res) => {
  const token = req.query.token;
  const tokenParam = encodeURIComponent(token);
  const q = (req.query.q || "").trim();
  const calls = getRecentCalls(200, { q });
  const rows = calls
    .map(
      (c) => `<tr>
        <td><a href="/admin/calls/${encodeURIComponent(c.call_sid)}?token=${tokenParam}">${escapeHtml(c.from_number || c.call_sid)}</a></td>
        <td class="mono">${escapeHtml(warsawDayLabel(c.started_at))}, ${escapeHtml(warsawTimeLabel(c.started_at))}</td>
        <td class="mono">${c.turns}</td>
      </tr>`
    )
    .join("");

  res.type("html").send(
    pageShell(
      "Rozmowy — Kruk AI",
      `${pageHeader(token, "calls")}
       <div class="wrap">
         <h1>Ostatnie rozmowy</h1>
         ${searchForm("/admin/calls", token, q, "Szukaj po numerze albo treści rozmowy…")}
         <p class="muted" style="margin-top:14px;">${calls.length} ${polishForm(calls.length, ["rozmowa", "rozmowy", "rozmów"])}${q ? ` dla „${escapeHtml(q)}”` : ""}. Kliknij numer, żeby zobaczyć pełny przebieg.</p>
         ${calls.length ? `<table><tr><th>Numer</th><th>Start</th><th>Tury</th></tr>${rows}</table>` : `<p class="empty-note">Nic nie znaleziono.</p>`}
       </div>`
    )
  );
});

router.get("/calls/:callSid", (req, res) => {
  const token = req.query.token;
  const tokenParam = encodeURIComponent(token);
  const turns = getCallTurns(req.params.callSid);
  const rows = turns
    .map(
      (t) => `<tr>
        <td class="mono">${escapeHtml(warsawTimeLabel(t.created_at))}</td>
        <td>${escapeHtml(t.route)}</td>
        <td>${t.speech_result ? escapeHtml(t.speech_result) : '<span class="muted">(cisza)</span>'}</td>
      </tr>`
    )
    .join("");

  res.type("html").send(
    pageShell(
      `Rozmowa ${req.params.callSid}`,
      `${pageHeader(token, "calls")}
       <div class="wrap">
         <p><a href="/admin/calls?token=${tokenParam}">&larr; wróć do listy</a></p>
         <h1>${escapeHtml(turns[0]?.from_number || "Nieznany numer")}</h1>
         <p class="muted mono" style="margin-top:4px;">${escapeHtml(req.params.callSid)}</p>
         <table><tr><th>Czas</th><th>Etap</th><th>Wypowiedź</th></tr>${rows || "<tr><td colspan=3 class=muted>Brak zapisanych tur.</td></tr>"}</table>
       </div>`
    )
  );
});

router.get("/callbacks", (req, res) => {
  const token = req.query.token;
  const showAll = req.query.filter === "all";
  const q = (req.query.q || "").trim();
  const requests = getCallbackRequests({ includeResolved: showAll, limit: 500, q });
  const pendingCount = countPendingCallbacks();
  const redirect = encodeURIComponent(req.originalUrl);

  const groups = groupByWarsawDay(requests);
  const groupsHtml = groups
    .map(
      (group) => `
       <h2 class="day-heading">${escapeHtml(group.label)}</h2>
       <table>
         <tr><th>Godz.</th><th>Kategoria</th><th>Numer</th><th>Problem</th><th>Oddzwonione</th></tr>
         ${group.items
           .map(
             (r) => `<tr class="${r.resolved ? "resolved" : ""}">
               <td class="mono">${warsawTimeLabel(r.created_at)}</td>
               <td>${categoryPill(r.category)}</td>
               <td class="mono">${r.client_phone ? `<a href="tel:${escapeHtml(r.client_phone)}">${escapeHtml(r.client_phone)}</a>` : '<span class="muted">brak</span>'}</td>
               <td>${r.summary ? escapeHtml(r.summary) : '<span class="muted">(brak treści)</span>'}</td>
               <td>
                 <form class="resolve-form" method="post" action="/admin/callbacks/${r.id}/resolve?token=${encodeURIComponent(token)}&redirect=${redirect}">
                   <input type="checkbox" name="resolved" value="1" ${r.resolved ? "checked" : ""} onchange="this.form.submit()">
                 </form>
               </td>
             </tr>`
           )
           .join("")}
       </table>`
    )
    .join("");

  const filterField = showAll ? '<input type="hidden" name="filter" value="all">' : "";

  res.type("html").send(
    pageShell(
      "Do oddzwonienia — Kruk AI",
      `${pageHeader(token, "callbacks")}
       <div class="wrap">
         <h1>Do oddzwonienia</h1>
         ${searchForm("/admin/callbacks", token, q, "Szukaj po numerze albo treści zgłoszenia…", filterField)}
         <p class="muted" style="margin-top:14px;">
           ${pendingCount} ${polishForm(pendingCount, ["nieodhaczone zgłoszenie", "nieodhaczone zgłoszenia", "nieodhaczonych zgłoszeń"])}.
           ${
             showAll
               ? `<a href="/admin/callbacks?token=${encodeURIComponent(token)}${q ? `&q=${encodeURIComponent(q)}` : ""}">pokaż tylko nieodhaczone</a>`
               : `<a href="/admin/callbacks?token=${encodeURIComponent(token)}&filter=all${q ? `&q=${encodeURIComponent(q)}` : ""}">pokaż też oddzwonione</a>`
           }
         </p>
         ${groupsHtml || '<p class="empty-note">Brak zgłoszeń.</p>'}
       </div>`
    )
  );
});

router.get("/sms", (req, res) => {
  const token = req.query.token;
  const q = (req.query.q || "").trim();
  const conversations = getSmsConversations(100, { q });

  const rows = conversations
    .map(
      (c) => `<tr>
        <td class="mono"><a href="/admin/sms/${encodeURIComponent(c.client_phone)}?token=${encodeURIComponent(token)}">${escapeHtml(c.client_phone)}</a></td>
        <td class="mono">${warsawDayLabel(c.last_at)}, ${warsawTimeLabel(c.last_at)}</td>
        <td>${c.last_direction === "in" ? '<span class="awaiting">czeka na odpowiedź</span>' : '<span class="muted">odpisano</span>'}</td>
        <td>${escapeHtml(String(c.last_body || "").slice(0, 120))}</td>
      </tr>`
    )
    .join("");

  res.type("html").send(
    pageShell(
      "SMS-y — Kruk AI",
      `${pageHeader(token, "sms")}
       <div class="wrap">
         <h1>SMS-y od klientów</h1>
         ${searchForm("/admin/sms", token, q, "Szukaj po numerze…")}
         <p class="muted" style="margin-top:14px;">${conversations.length} ${polishForm(conversations.length, ["rozmowa", "rozmowy", "rozmów"])}${q ? ` dla „${escapeHtml(q)}”` : ""}. Kliknij numer, żeby zobaczyć wątek i odpisać.</p>
         ${
           conversations.length > 0
             ? `<table><tr><th>Numer</th><th>Ostatnia</th><th>Status</th><th>Treść</th></tr>${rows}</table>`
             : `<p class="empty-note">${q ? "Nic nie znaleziono." : "Brak wiadomości. Tu pojawią się SMS-y wysłane na numer bota."}</p>`
         }
       </div>`
    )
  );
});

router.get("/sms/:phone", (req, res) => {
  const token = req.query.token;
  const phone = req.params.phone;
  const messages = getSmsThread(phone);

  const bubbles = messages
    .map(
      (m) => `<div class="msg ${m.direction === "in" ? "in" : "out"}">${escapeHtml(m.body || "")}
        <span class="meta">${m.direction === "in" ? "klient" : "salon"} · ${warsawDayLabel(m.created_at)}, ${warsawTimeLabel(m.created_at)}</span>
      </div>`
    )
    .join("");

  res.type("html").send(
    pageShell(
      `SMS — ${phone}`,
      `${pageHeader(token, "sms")}
       <div class="wrap">
         <p><a href="/admin/sms?token=${encodeURIComponent(token)}">&larr; wróć do listy</a></p>
         <h1>${escapeHtml(phone)}</h1>
         ${req.query.error ? `<p class="awaiting">Nie udało się wysłać: ${escapeHtml(req.query.error)}</p>` : ""}
         <div class="thread">${bubbles || '<p class="muted">Brak wiadomości w tym wątku.</p>'}</div>
         <form class="reply-box" method="post" action="/admin/sms/${encodeURIComponent(phone)}/reply?token=${encodeURIComponent(token)}">
           <textarea name="body" placeholder="Napisz odpowiedź do klienta…" maxlength="1200" required></textarea><br>
           <button type="submit" class="btn btn-accent">Wyślij SMS</button>
         </form>
       </div>`
    )
  );
});

router.post("/sms/:phone/reply", async (req, res) => {
  const token = encodeURIComponent(req.query.token);
  const phone = req.params.phone;
  const body = (req.body.body || "").trim();
  const threadUrl = `/admin/sms/${encodeURIComponent(phone)}?token=${token}`;

  if (!body) return res.redirect(threadUrl);

  // Odpowiedź musi wyjść z numeru, na który klient napisał — inaczej trafi w próżnię
  // albo zacznie osobny wątek na jego telefonie.
  const from = process.env.TWILIO_SMS_FROM;
  if (!from) {
    return res.redirect(`${threadUrl}&error=${encodeURIComponent("brak TWILIO_SMS_FROM w konfiguracji")}`);
  }

  try {
    const message = await getTwilioClient().messages.create({
      to: normalizePhoneNumber(phone),
      from: normalizePhoneNumber(from),
      body,
    });
    logSmsMessage({
      direction: "out",
      clientPhone: phone,
      body,
      twilioSid: message.sid,
      dedupeKey: `sms-out-${message.sid}`,
    });
    return res.redirect(threadUrl);
  } catch (err) {
    console.error("Nie udało się wysłać SMS-a z panelu:", err.message || err);
    return res.redirect(`${threadUrl}&error=${encodeURIComponent(err.message || "błąd wysyłki")}`);
  }
});

router.post("/callbacks/:id/resolve", (req, res) => {
  setCallbackResolved(Number(req.params.id), req.body.resolved === "1");
  const fallback = `/admin/callbacks?token=${encodeURIComponent(req.query.token)}`;
  // Tylko lokalna, względna ścieżka — redirect z query stringa nie może posłużyć jako open
  // redirect na obcą domenę.
  const redirect = req.query.redirect;
  const safeRedirect = typeof redirect === "string" && redirect.startsWith("/admin/") ? redirect : fallback;
  res.redirect(safeRedirect);
});

module.exports = router;
