const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || "test-admin-token";

const { startTestServer } = require("./helpers/app");
const { getSmsThread, getSmsConversations, logSmsMessage } = require("../src/services/callLog");

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
// Baza przeżywa między uruchomieniami testów — każdy przebieg używa własnych numerów.
const RUN = String(Date.now()).slice(-7);

async function postSms(fields) {
  const params = new URLSearchParams({ To: "+48732143591", ...fields });
  const res = await fetch(`${baseUrl}/sms/incoming`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return { status: res.status, body: await res.text() };
}

describe("SMS przychodzący — zastępuje domyślną odpowiedź demo Twilio", () => {
  const phone = `+4871${RUN}`;

  test("wiadomość jest zapisywana i potwierdzana klientowi", async () => {
    const { status, body } = await postSms({
      From: phone,
      Body: "Dzień dobry, czy da się przesunąć jutrzejszą wizytę?",
      MessageSid: `SM-${RUN}-1`,
    });

    assert.equal(status, 200);
    assert.match(body, /<Message>/);
    assert.match(body, /Przekazaliśmy ją do zespołu/);
    // Kluczowe: to NIE może być odpowiedź demonstracyjna Twilio.
    assert.doesNotMatch(body, /demo\.twilio\.com/i);

    const thread = getSmsThread(phone);
    assert.equal(thread.length, 1);
    assert.equal(thread[0].direction, "in");
    assert.match(thread[0].body, /przesunąć jutrzejszą wizytę/);
  });

  test("powtórzony webhook Twilio nie dubluje wiadomości", async () => {
    await postSms({ From: phone, Body: "powtórka", MessageSid: `SM-${RUN}-1` });
    const thread = getSmsThread(phone);
    assert.equal(thread.length, 1, "ten sam MessageSid musi dać jeden wpis");
  });

  test("wątek pojawia się na liście rozmów jako oczekujący na odpowiedź", () => {
    const conversation = getSmsConversations(200).find((c) => c.client_phone === phone);
    assert.ok(conversation, "wątek powinien być na liście");
    assert.equal(conversation.last_direction, "in");
  });
});

describe("SMS przychodzący — odrzucanie żądań bez podpisu Twilio", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  after(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test("bez podpisu dostaje 403, a nie wyjątek", async () => {
    process.env.NODE_ENV = "production";
    const res = await fetch(`${baseUrl}/sms/incoming`, { method: "POST" });
    assert.equal(res.status, 403);
  });
});

describe("Panel SMS", () => {
  const phone = `+4872${RUN}`;

  before(() => {
    logSmsMessage({ direction: "in", clientPhone: phone, body: "Pytanie od klienta", dedupeKey: `t-${RUN}-in` });
    logSmsMessage({ direction: "out", clientPhone: phone, body: "Odpowiedź salonu", dedupeKey: `t-${RUN}-out` });
  });

  test("bez tokena nie ma dostępu", async () => {
    const res = await fetch(`${baseUrl}/admin/sms`);
    assert.equal(res.status, 403);
  });

  test("lista rozmów pokazuje numer i ostatnią wiadomość", async () => {
    const res = await fetch(`${baseUrl}/admin/sms?token=${TOKEN}`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(body, new RegExp(phone.replace("+", "\\+")));
  });

  test("wątek pokazuje obie strony korespondencji i formularz odpowiedzi", async () => {
    const res = await fetch(`${baseUrl}/admin/sms/${encodeURIComponent(phone)}?token=${TOKEN}`);
    const body = await res.text();
    assert.match(body, /Pytanie od klienta/);
    assert.match(body, /Odpowiedź salonu/);
    assert.match(body, /<textarea name="body"/);
  });

  test("pusta odpowiedź nie próbuje niczego wysyłać", async () => {
    // Gdyby trafiła do Twilio, test wykonałby prawdziwe wywołanie API — stąd ten warunek w kodzie.
    const res = await fetch(`${baseUrl}/admin/sms/${encodeURIComponent(phone)}/reply?token=${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "body=",
    });
    assert.equal(res.status, 200); // po przekierowaniu wracamy na wątek
    assert.equal(getSmsThread(phone).length, 2, "nic nie powinno dojść do wątku");
  });

  test("brak numeru nadawcy w konfiguracji kończy się czytelnym błędem, nie wywołaniem Twilio", async () => {
    const original = process.env.TWILIO_SMS_FROM;
    delete process.env.TWILIO_SMS_FROM;
    try {
      const res = await fetch(`${baseUrl}/admin/sms/${encodeURIComponent(phone)}/reply?token=${TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "body=test",
      });
      const body = await res.text();
      assert.match(body, /brak TWILIO_SMS_FROM/);
      assert.equal(getSmsThread(phone).length, 2, "nieudana wysyłka nie zapisuje wiadomości");
    } finally {
      if (original === undefined) delete process.env.TWILIO_SMS_FROM;
      else process.env.TWILIO_SMS_FROM = original;
    }
  });
});
