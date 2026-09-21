const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || "test-admin-token";

const { startTestServer } = require("./helpers/app");
const {
  getCallbackRequests,
  countPendingCallbacks,
  logCallbackRequest,
  setCallbackResolved,
} = require("../src/services/callLog");

let baseUrl;
let closeServer;

before(async () => {
  const server = await startTestServer();
  baseUrl = server.baseUrl;
  closeServer = server.close;
});

after(async () => {
  await closeServer();
});

const TOKEN = process.env.ADMIN_TOKEN;

// Baza (data/calls.db) przeżywa między uruchomieniami testów, więc każdy przebieg musi używać
// własnych, unikalnych identyfikatorów — inaczej drugie `npm test` bez czyszczenia katalogu data/
// widziałoby wpisy z poprzedniego przebiegu i asercje na liczbę wierszy by się sypały.
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
let callCounter = 0;
function nextCallSid() {
  callCounter += 1;
  return `TEST-ADMIN-${RUN_ID}-${callCounter}`;
}

async function postVoice(path, fields) {
  const params = new URLSearchParams({
    From: "+48600000000",
    To: "+48123456789",
    CallSid: nextCallSid(),
    ...fields,
  });
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return { status: res.status, body: await res.text() };
}

describe("GET /admin/callbacks — autoryzacja", () => {
  test("bez tokena zwraca 403", async () => {
    const res = await fetch(`${baseUrl}/admin/callbacks`);
    assert.equal(res.status, 403);
  });
});

describe("Zgłoszenie [EN] trafia na listę 'do oddzwonienia'", () => {
  const clientPhone = `+4861${String(Date.now()).slice(-7)}`;

  test("rozpoznanie angielskiej mowy w /voice/intent loguje wpis kategorii EN", async () => {
    const { body } = await postVoice("/voice/intent?attempt=0", {
      From: clientPhone,
      SpeechResult: "Hello, I would like to book an appointment please",
    });
    assert.match(body, /call you back/);

    const entries = getCallbackRequests({ limit: 200 }).filter((r) => r.client_phone === clientPhone);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].category, "EN");
    assert.equal(entries[0].resolved, 0);
  });

  test("pojawia się na liście /admin/callbacks (widok domyślny — nieodhaczone)", async () => {
    const res = await fetch(`${baseUrl}/admin/callbacks?token=${TOKEN}`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(body, /EN</);
    assert.match(body, new RegExp(clientPhone.replace("+", "\\+")));
  });

  test("odhaczenie znika z domyślnego widoku, ale zostaje przy 'pokaż wszystkie'", async () => {
    const entry = getCallbackRequests({ limit: 200 }).find((r) => r.client_phone === clientPhone);
    assert.ok(entry, "wpis powinien istnieć po poprzednim teście");

    const resolveRes = await fetch(`${baseUrl}/admin/callbacks/${entry.id}/resolve?token=${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "resolved=1",
    });
    assert.equal(resolveRes.status, 200); // fetch podąża za redirectem 302 → 200 na liście
    const afterResolveBody = await resolveRes.text();
    assert.doesNotMatch(afterResolveBody, new RegExp(clientPhone.replace("+", "\\+")));

    const allRes = await fetch(`${baseUrl}/admin/callbacks?token=${TOKEN}&filter=all`);
    const allBody = await allRes.text();
    assert.match(allBody, new RegExp(clientPhone.replace("+", "\\+")));
    assert.match(allBody, /class="resolved"/);

    const updated = getCallbackRequests({ limit: 200 }).find((r) => r.id === entry.id);
    assert.equal(updated.resolved, 1);
    assert.ok(updated.resolved_at);
  });
});

// Błąd znaleziony w przeglądzie 15.09.2026: powtórzony webhook Twilio (po timeoucie) robił drugi
// wpis w rejestrze, mimo że SMS do zespołu był deduplikowany.
describe("Rejestr nie dubluje zgłoszeń z tej samej rozmowy", () => {
  test("dwa zapisy z tym samym dedupeKey dają jeden wiersz", () => {
    const callSid = nextCallSid();
    const dedupeKey = `${callSid}-zapis`;
    const clientPhone = `+4862${String(Date.now()).slice(-7)}`;

    logCallbackRequest({ callSid, category: "ZAPIS", clientPhone, summary: "pierwsze", dedupeKey });
    logCallbackRequest({ callSid, category: "ZAPIS", clientPhone, summary: "powtórka", dedupeKey });

    const entries = getCallbackRequests({ limit: 200 }).filter((r) => r.call_sid === callSid);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].summary, "pierwsze");
  });

  test("różne kategorie z tej samej rozmowy to nadal osobne wpisy", () => {
    const callSid = nextCallSid();

    logCallbackRequest({
      callSid,
      category: "ZAPIS",
      summary: "zapis",
      dedupeKey: `${callSid}-zapis`,
    });
    logCallbackRequest({
      callSid,
      category: "INNE",
      summary: "inne",
      dedupeKey: `${callSid}-inne`,
    });

    const entries = getCallbackRequests({ limit: 200 }).filter((r) => r.call_sid === callSid);
    assert.equal(entries.length, 2);
  });
});

// Błąd znaleziony w przeglądzie 15.09.2026: filtr "nieodhaczone" działał w JS PO pobraniu limitu,
// więc po przekroczeniu limitu stare, wciąż nieodhaczone zgłoszenie po cichu wypadało z widoku.
describe("Filtr nieodhaczonych nie gubi starych zgłoszeń", () => {
  test("stare nieodhaczone zgłoszenie przebija się przez limit zajęty przez nowsze odhaczone", () => {
    const oldCallSid = nextCallSid();
    logCallbackRequest({
      callSid: oldCallSid,
      category: "ZAPIS",
      summary: "stare, wciąż nieodhaczone",
      dedupeKey: `${oldCallSid}-zapis`,
    });

    // Trzy NOWSZE zgłoszenia, wszystkie odhaczone — przy filtrowaniu w JS zajęłyby cały limit
    // i stare zgłoszenie wyżej nigdy by się nie pokazało.
    for (let i = 0; i < 3; i += 1) {
      const callSid = nextCallSid();
      logCallbackRequest({
        callSid,
        category: "INNE",
        summary: `nowsze ${i}`,
        dedupeKey: `${callSid}-inne`,
      });
      const inserted = getCallbackRequests({ limit: 10 }).find((r) => r.call_sid === callSid);
      setCallbackResolved(inserted.id, true);
    }

    const pending = getCallbackRequests({ includeResolved: false, limit: 3 });
    assert.ok(
      pending.some((r) => r.call_sid === oldCallSid),
      "stare nieodhaczone zgłoszenie musi być widoczne mimo limitu"
    );
  });

  test("countPendingCallbacks liczy po całej tabeli, nie po oknie limitu", () => {
    const callSid = nextCallSid();
    const before = countPendingCallbacks();
    logCallbackRequest({
      callSid,
      category: "INNE",
      summary: "kolejne oczekujące",
      dedupeKey: `${callSid}-inne`,
    });

    // Celowo ">=", a nie dokładne "+1": pliki testowe biegną w osobnych procesach na tej samej
    // bazie, a testy tras /voice/* też potrafią dopisać zgłoszenie w tle. Istotne jest, że
    // licznik widzi nowy wiersz — nie to, że nikt inny nic w międzyczasie nie zapisał.
    assert.ok(
      countPendingCallbacks() >= before + 1,
      "licznik nie zobaczył nowego nieodhaczonego zgłoszenia"
    );
  });
});
