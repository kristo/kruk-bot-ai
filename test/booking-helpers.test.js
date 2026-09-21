const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");

require("dotenv").config();
const voiceRouter = require("../src/routes/voice");
const { sanitizeNameField, extractBarberName, willSendBooksySms } = voiceRouter._test;

describe("sanitizeNameField", () => {
  test("odrzuca wartość, która wygląda jak nazwa salonu/ulicy", () => {
    // Realny przypadek z produkcji: regex imienia złapał fragment nazwy ulicy zamiast imienia.
    assert.equal(sanitizeNameField("Dywizjonu 303"), null);
  });

  test("przepuszcza prawdziwe imię", () => {
    assert.equal(sanitizeNameField("Kamil"), "Kamil");
  });

  test("null wejście daje null", () => {
    assert.equal(sanitizeNameField(null), null);
  });
});

describe("extractBarberName", () => {
  test("łapie imię barbera po 'do'/'u'", () => {
    assert.equal(extractBarberName("Chcę się umówić do Pawła"), "Pawła");
  });

  test("zwraca null bez wzmianki o barberze", () => {
    assert.equal(extractBarberName("Chcę się zapisać na jutro"), null);
  });
});

// Bot nie może obiecywać SMS-a, którego nie wyśle — znalezione w przeglądzie 15.09.2026.
// Sam warunek, bez dotykania trasy: wysyłka wymaga włączonej flagi ORAZ znanego numeru
// dzwoniącego (numer zastrzeżony = brak SMS-a, mimo włączonej flagi).
describe("willSendBooksySms", () => {
  const originalFlag = process.env.SEND_CLIENT_BOOKSY_SMS;

  after(() => {
    if (originalFlag === undefined) delete process.env.SEND_CLIENT_BOOKSY_SMS;
    else process.env.SEND_CLIENT_BOOKSY_SMS = originalFlag;
  });

  test("wyłączona flaga = nie obiecujemy SMS-a", () => {
    process.env.SEND_CLIENT_BOOKSY_SMS = "false";
    assert.equal(willSendBooksySms("+48600000000"), false);
  });

  test("włączona flaga, ale nieznany numer dzwoniącego = nie obiecujemy SMS-a", () => {
    process.env.SEND_CLIENT_BOOKSY_SMS = "true";
    assert.equal(willSendBooksySms(null), false);
    assert.equal(willSendBooksySms(""), false);
  });

  test("włączona flaga i znany numer = obiecujemy SMS-a", () => {
    process.env.SEND_CLIENT_BOOKSY_SMS = "true";
    assert.equal(willSendBooksySms("+48600000000"), true);
  });
});
