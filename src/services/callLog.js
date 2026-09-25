/**
 * Trwały zapis transkryptów rozmów — od Krzysztofa, 13.09.2026 ("brak realnego wglądu w jakość
 * rozmów"). Do tej pory jedynym śladem był ulotny log konsoli Railway, przeszukiwany ręcznie na
 * żądanie. Ten moduł zapisuje każdą turę rozmowy do lokalnego pliku SQLite (node:sqlite,
 * wbudowane od Node 22 — bez dodatkowej zależności npm), żeby Wiktoria/Damian mogli sami
 * przejrzeć historię pod /admin/calls bez proszenia o to za każdym razem.
 *
 * WAŻNE: plik bazy musi leżeć na trwałym wolumenie Railway (nie na efemerycznym systemie
 * plików kontenera), inaczej historia zniknie przy każdym redeployu. Ścieżka konfigurowana
 * przez DATA_DIR (domyślnie ./data lokalnie).
 */
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "..", "data");
const DB_PATH = path.join(DATA_DIR, "calls.db");

let db = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  // busy_timeout MUSI być ustawiony jako pierwszy, osobnym poleceniem: przełączenie na WAL
  // wymaga na moment wyłącznego dostępu do pliku, a przy wdrożeniu na Railway nowy kontener
  // startuje, zanim zgaśnie stary — obie instancje sięgają wtedy po tę samą bazę na wolumenie.
  // Gdy oba PRAGMA szły jednym exec-em, konwersja do WAL wykonywała się jeszcze przy zerowym
  // timeoucie i od razu wywracała się na "database is locked", zabierając ze sobą całą
  // inicjalizację bazy (brak zapisu transkryptów i zgłoszeń, 500 w panelu). Odtworzone lokalnie
  // ośmioma równoległymi startami, 15.09.2026.
  db.exec("PRAGMA busy_timeout = 5000;");
  // WAL pozwala czytać (np. odświeżanie /admin/callbacks) w trakcie zapisu (nowa tura rozmowy,
  // odhaczenie oddzwonienia) bez blokowania się nawzajem.
  ensureWalMode(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS call_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_sid TEXT NOT NULL,
      created_at TEXT NOT NULL,
      route TEXT NOT NULL,
      from_number TEXT,
      speech_result TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_call_turns_call_sid ON call_turns(call_sid);
    CREATE INDEX IF NOT EXISTS idx_call_turns_created_at ON call_turns(created_at);

    CREATE TABLE IF NOT EXISTS callback_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_sid TEXT,
      created_at TEXT NOT NULL,
      category TEXT NOT NULL,
      client_phone TEXT,
      summary TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_callback_requests_created_at ON callback_requests(created_at);

    CREATE TABLE IF NOT EXISTS sms_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      direction TEXT NOT NULL,
      client_phone TEXT NOT NULL,
      body TEXT,
      twilio_sid TEXT,
      dedupe_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sms_messages_phone ON sms_messages(client_phone, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_messages_dedupe_key ON sms_messages(dedupe_key);
  `);

  // Tabela istnieje już na produkcji (wdrożona 14.09.2026) bez tej kolumny, a CREATE TABLE
  // IF NOT EXISTS jej tam nie dołoży — stąd osobna migracja. SQLite nie umie dodać kolumny
  // UNIQUE przez ALTER TABLE, więc unikalność wymuszamy osobnym indeksem (wiele NULL-i jest
  // w nim dozwolonych, więc stare wiersze bez klucza nie kolidują ze sobą).
  addColumnIfMissing(db, "callback_requests", "dedupe_key", "TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_callback_requests_dedupe_key ON callback_requests(dedupe_key);"
  );

  return db;
}

// Sprawdzenie i ALTER TABLE nie są jedną operacją atomową, a przy wdrożeniu na Railway nowy
// kontener startuje, zanim zgaśnie stary — obie instancje mogą więc naraz zobaczyć brak kolumny
// i obie spróbować ją dodać. Przegrany dostaje "duplicate column name" i bez tego przechwycenia
// wywracał całą inicjalizację bazy (czyli: brak zapisu transkryptów i zgłoszeń). Skutek
// docelowy jest ten sam — kolumna istnieje — więc ten konkretny błąd można bezpiecznie zignorować.
// Przestawienie na WAL wymaga na moment wyłącznego dostępu, więc przy dwóch startujących naraz
// procesach potrafi się nie udać — i co gorsza SQLite sygnalizuje to, ZWRACAJĄC dotychczasowy
// tryb, a nie rzucając błędem. Zostawienie bazy w starym trybie oznacza gubione zapisy przy
// współbieżności (zmierzone), a po udanej konwersji równoległe zapisy przechodzą bezbłędnie —
// dlatego ponawiamy do skutku, sprawdzając faktyczny tryb zwrócony przez PRAGMA.
function ensureWalMode(database) {
  for (let attempt = 0; ; attempt += 1) {
    let mode = null;
    try {
      mode = database.prepare("PRAGMA journal_mode = WAL").get().journal_mode;
    } catch (err) {
      if (!/database is locked|busy/i.test(err.message || "")) throw err;
    }

    if (String(mode).toLowerCase() === "wal") return;
    if (attempt >= BUSY_RETRY_DELAYS_MS.length) {
      // Baza zostaje w trybie rollback journal — działa, tylko gorzej znosi współbieżność.
      console.error("Nie udało się przestawić bazy na WAL — zostaje tryb:", mode);
      return;
    }
    sleepSync(BUSY_RETRY_DELAYS_MS[attempt]);
  }
}

function addColumnIfMissing(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;

  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message || "")) throw err;
  }
}

// SQLite potrafi odrzucić zapis przez SQLITE_BUSY, gdy inny proces trzyma blokadę — w praktyce
// zdarza się to tylko w wąskim oknie: świeża baza (jeszcze nie przestawiona na WAL) plus dwa
// kontenery naraz przy wdrożeniu na Railway. busy_timeout nie pomaga we wszystkich takich
// przypadkach, a cicho zgubione zgłoszenie oznacza klienta, który czeka na telefon, o którym
// nikt nie wie. Stąd krótkie ponowienie. Odtworzone lokalnie równoległymi startami, 15.09.2026.
const BUSY_RETRY_DELAYS_MS = [20, 50, 120];

function sleepSync(ms) {
  // DatabaseSync jest synchroniczne, więc nie ma tu await — Atomics.wait usypia wątek
  // bez kręcenia pustej pętli na procesorze.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runWithBusyRetry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (err) {
      const isBusy = /database is locked|busy/i.test(err.message || "");
      if (!isBusy || attempt >= BUSY_RETRY_DELAYS_MS.length) throw err;
      sleepSync(BUSY_RETRY_DELAYS_MS[attempt]);
    }
  }
}

// Zapis transkryptu NIGDY nie może wysadzić obsługi połączenia — to funkcja pomocnicza,
// nie krytyczna ścieżka. Błędy zapisu są tylko logowane do konsoli.
function logCallTurn({ callSid, route, from, speech }) {
  try {
    const database = getDb();
    const stmt = database.prepare(
      "INSERT INTO call_turns (call_sid, created_at, route, from_number, speech_result) VALUES (?, ?, ?, ?, ?)"
    );
    stmt.run(callSid || "brak-callsid", new Date().toISOString(), route, from || null, speech || null);
  } catch (err) {
    console.error("Nie udało się zapisać transkryptu rozmowy:", err.message || err);
  }
}

// % i _ mają znaczenie specjalne w LIKE — bez ucieczki szukanie frazy "50%" albo "a_b" dawałoby
// zaskakujące trafienia. Znak ucieczki "\" ustawiany jawnie w ESCAPE, bo SQLite go nie zakłada.
function escapeLikeTerm(term) {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Lista rozmów pogrupowana po CallSid, najnowsze pierwsze — do widoku listy w /admin/calls.
// Opcjonalne `q` szuka po numerze dzwoniącego ORAZ po treści dowolnej tury (np. nazwa ulicy) —
// od Krzysztofa, 24.09.2026, żeby nie trzeba było przewijać płaskiej listy ręcznie.
function getRecentCalls(limit = 100, { q } = {}) {
  const database = getDb();
  if (!q) {
    return database
      .prepare(
        `SELECT call_sid, MIN(created_at) AS started_at, MAX(created_at) AS last_at,
                COUNT(*) AS turns, MAX(from_number) AS from_number
         FROM call_turns
         GROUP BY call_sid
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .all(limit);
  }

  const pattern = `%${escapeLikeTerm(q)}%`;
  return database
    .prepare(
      `SELECT call_sid, MIN(created_at) AS started_at, MAX(created_at) AS last_at,
              COUNT(*) AS turns, MAX(from_number) AS from_number
       FROM call_turns
       WHERE call_sid IN (
         SELECT DISTINCT call_sid FROM call_turns
         WHERE from_number LIKE ? ESCAPE '\\' OR speech_result LIKE ? ESCAPE '\\'
       )
       GROUP BY call_sid
       ORDER BY started_at DESC
       LIMIT ?`
    )
    .all(pattern, pattern, limit);
}

// Liczba unikalnych rozmów od danej daty granicznej — do statystyk "dziś" na dashboardzie.
function countCallsSince(cutoffIso) {
  const database = getDb();
  return database
    .prepare("SELECT COUNT(DISTINCT call_sid) AS count FROM call_turns WHERE created_at >= ?")
    .get(cutoffIso).count;
}

// Pełny przebieg jednej rozmowy, w kolejności chronologicznej — do widoku szczegółów.
function getCallTurns(callSid) {
  const database = getDb();
  return database
    .prepare("SELECT * FROM call_turns WHERE call_sid = ? ORDER BY created_at ASC, id ASC")
    .all(callSid);
}

// Jednorazowe czyszczenie ruchu testowego/przedwdrożeniowego z /admin/calls i /admin/sms — od
// Krzysztofa, 24.09.2026. Zwraca liczbę usuniętych wierszy, żeby dało się to potwierdzić przed
// i po uruchomieniu skryptu (patrz scripts/purge_pre_launch_data.js), zamiast usuwać po cichu.
function deleteCallTurnsBefore(cutoffIso) {
  const database = getDb();
  const result = runWithBusyRetry(() =>
    database.prepare("DELETE FROM call_turns WHERE created_at < ?").run(cutoffIso)
  );
  return result.changes;
}

function deleteSmsMessagesBefore(cutoffIso) {
  const database = getDb();
  const result = runWithBusyRetry(() =>
    database.prepare("DELETE FROM sms_messages WHERE created_at < ?").run(cutoffIso)
  );
  return result.changes;
}

// Zgłoszenie "Wiktoria oddzwoni" — od Krzysztofa, 14.09.2026 ("widok z transkryptami, ale bez
// listy kto czeka na oddzwonienie"). Logowane niezależnie od tego, czy wysyłka SMS/WhatsApp do
// zespołu jest włączona (SEND_INTERNAL_NOTIFICATIONS) — to osobny, trwały ślad "do zrobienia" do
// przejrzenia w /admin/callbacks, nie duplikat mechanizmu powiadomień. Tak jak logCallTurn, nigdy
// nie rzuca — zapis nie może wywrócić obsługi połączenia.
// dedupeKey to ten sam klucz, którym deduplikowana jest wysyłka SMS/WhatsApp (keyBase w voice.js) —
// jedno zgłoszenie z jednej rozmowy ma dawać jeden wpis, nawet gdy Twilio powtórzy webhooka po
// timeoucie. Bez tego powtórka dawała drugi SMS zablokowany przez sentMessageKeys, ale zdublowany
// wiersz w rejestrze. INSERT OR IGNORE zamiast sprawdzania w pamięci, żeby działało też po redeployu.
function logCallbackRequest({ callSid, category, clientPhone, summary, dedupeKey }) {
  try {
    const database = getDb();
    const stmt = database.prepare(
      `INSERT OR IGNORE INTO callback_requests
         (call_sid, created_at, category, client_phone, summary, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    runWithBusyRetry(() =>
      stmt.run(
        callSid || "brak-callsid",
        new Date().toISOString(),
        category,
        clientPhone || null,
        summary || null,
        dedupeKey || null
      )
    );
  } catch (err) {
    console.error("Nie udało się zapisać zgłoszenia oddzwonienia:", err.message || err);
  }
}

// Zgłoszenia do widoku /admin/callbacks, najnowsze pierwsze (grupowanie po dniu robi warstwa
// prezentacji). Filtr "tylko nieodhaczone" MUSI iść do SQL-a, a nie po pobraniu listy: przy
// filtrowaniu w JS limit obcinał najpierw wszystkie zgłoszenia, więc po przekroczeniu limitu
// stare, wciąż nieodhaczone zgłoszenie po cichu wypadało z widoku — czyli dokładnie to, przed
// czym ten rejestr ma chronić. Znalezione w przeglądzie 15.09.2026.
// Opcjonalne `q` (numer klienta albo treść zgłoszenia) idzie do tego samego WHERE co filtr
// "tylko nieodhaczone" — z tego samego powodu co komentarz wyżej: filtrowanie po pobraniu z
// LIMIT-em potrafi po cichu zgubić stare, pasujące zgłoszenie.
function getCallbackRequests({ includeResolved = true, limit = 500, q } = {}) {
  const database = getDb();
  const conditions = [];
  const params = [];
  if (!includeResolved) conditions.push("resolved = 0");
  if (q) {
    conditions.push("(client_phone LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLikeTerm(q)}%`;
    params.push(pattern, pattern);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  return database
    .prepare(`SELECT * FROM callback_requests ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params);
}

function countPendingCallbacks() {
  const database = getDb();
  return database.prepare("SELECT COUNT(*) AS count FROM callback_requests WHERE resolved = 0").get().count;
}

// Rozkład dzisiejszych zgłoszeń po kategorii (ZAPIS/SPÓŹNIENIE/INNE/...) — do dashboardu.
function getCallbackCategoryCountsSince(cutoffIso) {
  const database = getDb();
  return database
    .prepare(
      `SELECT category, COUNT(*) AS count FROM callback_requests
       WHERE created_at >= ? GROUP BY category ORDER BY count DESC`
    )
    .all(cutoffIso);
}

function setCallbackResolved(id, resolved) {
  const database = getDb();
  const stmt = database.prepare(
    "UPDATE callback_requests SET resolved = ?, resolved_at = ? WHERE id = ?"
  );
  runWithBusyRetry(() => stmt.run(resolved ? 1 : 0, resolved ? new Date().toISOString() : null, id));
}

// Numery zapisujemy w jednej, znormalizowanej postaci (bez spacji i myślników), żeby wątek
// rozmowy z tym samym klientem nie rozpadł się na kilka tylko dlatego, że Twilio raz podało
// numer inaczej niż wpisano go ręcznie w panelu.
function normalizeSmsPhone(phone) {
  return String(phone || "").replace(/[\s()-]/g, "");
}

// Jedna wiadomość SMS — przychodząca ("in") albo wysłana z panelu ("out").
// dedupeKey chroni przed powtórzonym webhookiem Twilio, tak jak w callback_requests.
function logSmsMessage({ direction, clientPhone, body, twilioSid, dedupeKey }) {
  try {
    const database = getDb();
    const stmt = database.prepare(
      `INSERT OR IGNORE INTO sms_messages (created_at, direction, client_phone, body, twilio_sid, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    runWithBusyRetry(() =>
      stmt.run(
        new Date().toISOString(),
        direction,
        normalizeSmsPhone(clientPhone),
        body || null,
        twilioSid || null,
        dedupeKey || null
      )
    );
  } catch (err) {
    console.error("Nie udało się zapisać wiadomości SMS:", err.message || err);
  }
}

// Pełna korespondencja z jednym numerem, chronologicznie — do widoku wątku w panelu.
function getSmsThread(clientPhone, limit = 200) {
  const database = getDb();
  return database
    .prepare(
      "SELECT * FROM sms_messages WHERE client_phone = ? ORDER BY created_at ASC, id ASC LIMIT ?"
    )
    .all(normalizeSmsPhone(clientPhone), limit);
}

// Lista rozmów SMS: po jednym wierszu na numer, z ostatnią wiadomością i liczbą nieprzeczytanych
// (czyli przychodzących, na które nie poszła jeszcze żadna późniejsza odpowiedź z panelu).
// Opcjonalne `q` filtruje po numerze — do wyszukiwarki w /admin/sms, od Krzysztofa, 24.09.2026.
function getSmsConversations(limit = 100, { q } = {}) {
  const database = getDb();
  const where = q ? "WHERE client_phone LIKE ? ESCAPE '\\'" : "";
  const params = q ? [`%${escapeLikeTerm(q)}%`, limit] : [limit];
  return database
    .prepare(
      `SELECT client_phone,
              MAX(created_at) AS last_at,
              COUNT(*) AS messages,
              SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS incoming,
              (SELECT body FROM sms_messages m2
                WHERE m2.client_phone = m1.client_phone
                ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1) AS last_body,
              (SELECT direction FROM sms_messages m3
                WHERE m3.client_phone = m1.client_phone
                ORDER BY m3.created_at DESC, m3.id DESC LIMIT 1) AS last_direction
       FROM sms_messages m1
       ${where}
       GROUP BY client_phone
       ORDER BY last_at DESC
       LIMIT ?`
    )
    .all(...params);
}

// Liczba wszystkich wiadomości (przychodzących i wychodzących) od danej daty — do dashboardu.
function countSmsMessagesSince(cutoffIso) {
  const database = getDb();
  return database
    .prepare("SELECT COUNT(*) AS count FROM sms_messages WHERE created_at >= ?")
    .get(cutoffIso).count;
}

// Ile wątków czeka na odpowiedź — ostatnia wiadomość jest od klienta.
function countAwaitingSmsReplies() {
  return getSmsConversations(500).filter((c) => c.last_direction === "in").length;
}

module.exports = {
  logCallTurn,
  getRecentCalls,
  getCallTurns,
  countCallsSince,
  deleteCallTurnsBefore,
  deleteSmsMessagesBefore,
  logSmsMessage,
  getSmsThread,
  getSmsConversations,
  countSmsMessagesSince,
  countAwaitingSmsReplies,
  normalizeSmsPhone,
  logCallbackRequest,
  getCallbackRequests,
  getCallbackCategoryCountsSince,
  countPendingCallbacks,
  setCallbackResolved,
};
