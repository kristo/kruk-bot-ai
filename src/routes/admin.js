/**
 * Prosty podgląd historii rozmów dla Wiktorii/Damiana — od Krzysztofa, 13.09.2026. Zamiast
 * proszenia o ręczne przeszukanie logów Railway za każdym razem, można to teraz sprawdzić
 * samodzielnie pod jednym zakładkowanym linkiem.
 *
 * Zabezpieczenie: pojedynczy token w query string (ADMIN_TOKEN) — nie ma tu systemu kont,
 * to najprostsze rozwiązanie adekwatne do wagi tych danych (transkrypty rozmów o wizytach
 * fryzjerskich, nie dane wrażliwe/finansowe). Link z tokenem wystarczy zapisać w zakładce.
 */
const express = require("express");
const {
  getRecentCalls,
  getCallTurns,
  getCallbackRequests,
  countPendingCallbacks,
  setCallbackResolved,
  logSmsMessage,
  getSmsThread,
  getSmsConversations,
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

function pageShell(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  td, th { border: 1px solid #ddd; padding: 8px 12px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; }
  tr:hover { background: #fafafa; }
  a { color: #0645ad; }
  .muted { color: #888; font-style: italic; }
  nav.tabs { margin-bottom: 1rem; }
  nav.tabs a { display: inline-block; padding: 6px 14px; margin-right: 8px; border: 1px solid #ddd; border-radius: 6px; text-decoration: none; }
  nav.tabs a.active { background: #0645ad; color: #fff; border-color: #0645ad; }
  h2.day-heading { margin-top: 2rem; margin-bottom: 0.25rem; }
  tr.resolved { opacity: 0.5; }
  tr.resolved td { text-decoration: line-through; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; background: #eef; font-size: 0.85em; }
  form.resolve-form { margin: 0; }
  .msg { max-width: 34rem; padding: 8px 12px; margin: 6px 0; border-radius: 10px; white-space: pre-wrap; }
  .msg.in { background: #f1f1f1; }
  .msg.out { background: #dce9ff; margin-left: auto; }
  .msg .meta { display: block; font-size: 0.78em; color: #777; margin-top: 4px; }
  .thread { display: flex; flex-direction: column; margin-top: 1rem; }
  .reply-box { margin-top: 1.5rem; }
  .reply-box textarea { width: 100%; max-width: 34rem; min-height: 5rem; padding: 8px; font: inherit; }
  .reply-box button { margin-top: 8px; padding: 8px 18px; font: inherit; cursor: pointer; }
  .awaiting { font-weight: bold; color: #b4501e; }
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

function navBar(token, active) {
  const tab = (href, label, key) =>
    `<a href="${href}?token=${encodeURIComponent(token)}" class="${key === active ? "active" : ""}">${label}</a>`;
  const awaiting = countAwaitingSmsReplies();
  const smsLabel = awaiting > 0 ? `SMS-y (${awaiting})` : "SMS-y";
  return `<nav class="tabs">${tab("/admin/calls", "Rozmowy", "calls")}${tab(
    "/admin/callbacks",
    "Do oddzwonienia",
    "callbacks"
  )}${tab("/admin/sms", smsLabel, "sms")}</nav>`;
}

router.get("/calls", (req, res) => {
  const token = encodeURIComponent(req.query.token);
  const calls = getRecentCalls(200);
  const rows = calls
    .map(
      (c) => `<tr>
        <td><a href="/admin/calls/${encodeURIComponent(c.call_sid)}?token=${token}">${escapeHtml(c.call_sid)}</a></td>
        <td>${escapeHtml(c.started_at)}</td>
        <td>${escapeHtml(c.from_number)}</td>
        <td>${c.turns}</td>
      </tr>`
    )
    .join("");

  res.type("html").send(
    pageShell(
      "Rozmowy — Kruk Bot",
      `${navBar(req.query.token, "calls")}
       <h1>Ostatnie rozmowy</h1>
       <p class="muted">${calls.length} ${polishForm(calls.length, ["rozmowa", "rozmowy", "rozmów"])}. Kliknij CallSid, żeby zobaczyć pełny przebieg.</p>
       <table><tr><th>CallSid</th><th>Start</th><th>Numer</th><th>Liczba tur</th></tr>${rows}</table>`
    )
  );
});

router.get("/calls/:callSid", (req, res) => {
  const token = encodeURIComponent(req.query.token);
  const turns = getCallTurns(req.params.callSid);
  const rows = turns
    .map(
      (t) => `<tr>
        <td>${escapeHtml(t.created_at)}</td>
        <td>${escapeHtml(t.route)}</td>
        <td>${t.speech_result ? escapeHtml(t.speech_result) : '<span class="muted">(cisza)</span>'}</td>
      </tr>`
    )
    .join("");

  res.type("html").send(
    pageShell(
      `Rozmowa ${req.params.callSid}`,
      `${navBar(req.query.token, "calls")}
       <p><a href="/admin/calls?token=${token}">&larr; wróć do listy</a></p>
       <h1>Rozmowa ${escapeHtml(req.params.callSid)}</h1>
       <table><tr><th>Czas</th><th>Etap</th><th>Wypowiedź</th></tr>${rows || "<tr><td colspan=3 class=muted>Brak zapisanych tur.</td></tr>"}</table>`
    )
  );
});

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

router.get("/callbacks", (req, res) => {
  const token = req.query.token;
  const showAll = req.query.filter === "all";
  const requests = getCallbackRequests({ includeResolved: showAll, limit: 500 });
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
               <td>${warsawTimeLabel(r.created_at)}</td>
               <td><span class="badge">${escapeHtml(r.category)}</span></td>
               <td>${r.client_phone ? `<a href="tel:${escapeHtml(r.client_phone)}">${escapeHtml(r.client_phone)}</a>` : '<span class="muted">brak</span>'}</td>
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

  res.type("html").send(
    pageShell(
      "Do oddzwonienia — Kruk Bot",
      `${navBar(token, "callbacks")}
       <h1>Do oddzwonienia</h1>
       <p class="muted">
         ${pendingCount} ${polishForm(pendingCount, ["nieodhaczone zgłoszenie", "nieodhaczone zgłoszenia", "nieodhaczonych zgłoszeń"])}.
         ${
           showAll
             ? `<a href="/admin/callbacks?token=${encodeURIComponent(token)}">pokaż tylko nieodhaczone</a>`
             : `<a href="/admin/callbacks?token=${encodeURIComponent(token)}&filter=all">pokaż też oddzwonione</a>`
         }
       </p>
       ${groupsHtml || '<p class="muted">Brak zgłoszeń.</p>'}`
    )
  );
});

router.get("/sms", (req, res) => {
  const token = req.query.token;
  const conversations = getSmsConversations(100);

  const rows = conversations
    .map(
      (c) => `<tr>
        <td><a href="/admin/sms/${encodeURIComponent(c.client_phone)}?token=${encodeURIComponent(token)}">${escapeHtml(c.client_phone)}</a></td>
        <td>${warsawDayLabel(c.last_at)}, ${warsawTimeLabel(c.last_at)}</td>
        <td>${c.last_direction === "in" ? '<span class="awaiting">czeka na odpowiedź</span>' : "odpisano"}</td>
        <td>${escapeHtml(String(c.last_body || "").slice(0, 120))}</td>
      </tr>`
    )
    .join("");

  res.type("html").send(
    pageShell(
      "SMS-y — Kruk Bot",
      `${navBar(token, "sms")}
       <h1>SMS-y od klientów</h1>
       <p class="muted">${conversations.length} ${polishForm(conversations.length, ["rozmowa", "rozmowy", "rozmów"])}. Kliknij numer, żeby zobaczyć wątek i odpisać.</p>
       ${
         conversations.length > 0
           ? `<table><tr><th>Numer</th><th>Ostatnia</th><th>Status</th><th>Treść</th></tr>${rows}</table>`
           : '<p class="muted">Brak wiadomości. Tu pojawią się SMS-y wysłane na numer bota.</p>'
       }`
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
      `${navBar(token, "sms")}
       <p><a href="/admin/sms?token=${encodeURIComponent(token)}">&larr; wróć do listy</a></p>
       <h1>${escapeHtml(phone)}</h1>
       ${req.query.error ? `<p class="awaiting">Nie udało się wysłać: ${escapeHtml(req.query.error)}</p>` : ""}
       <div class="thread">${bubbles || '<p class="muted">Brak wiadomości w tym wątku.</p>'}</div>
       <form class="reply-box" method="post" action="/admin/sms/${encodeURIComponent(phone)}/reply?token=${encodeURIComponent(token)}">
         <textarea name="body" placeholder="Napisz odpowiedź do klienta…" maxlength="1200" required></textarea>
         <button type="submit">Wyślij SMS</button>
       </form>`
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
