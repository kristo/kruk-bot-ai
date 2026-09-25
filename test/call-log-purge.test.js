const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// deleteCallTurnsBefore/deleteSmsMessagesBefore usuwają WSZYSTKO starsze niż podana data, nie
// tylko wiersz z tego testu — więc testujemy na własnej, izolowanej bazie w katalogu tymczasowym,
// a nie na współdzielonej ./data/calls.db, żeby nie zmiatać wpisów, które w tym samym momencie
// tworzą inne pliki testowe (node --test uruchamia pliki w osobnych procesach, ale wszystkie
// mogłyby trafić w ten sam plik SQLite, gdyby DATA_DIR nie było nadpisane tutaj, przed pierwszym
// require callLog.js).
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kruk-purge-test-"));
process.env.DATA_DIR = tmpDataDir;

const {
  logCallTurn,
  getCallTurns,
  deleteCallTurnsBefore,
  logSmsMessage,
  getSmsThread,
  deleteSmsMessagesBefore,
} = require("../src/services/callLog");

after(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("deleteCallTurnsBefore / deleteSmsMessagesBefore — czyszczenie sprzed daty granicznej", () => {
  test("wpis sprzed daty granicznej znika, świeży wpis zostaje nietknięty", () => {
    const callSid = "PURGE-TEST-CALL";
    logCallTurn({ callSid, route: "/voice/incoming", from: "+48600000000", speech: null });

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    assert.equal(deleteCallTurnsBefore(oneHourAgo), 0, "wpis sprzed chwili nie jest starszy niż godzinę temu");
    assert.equal(getCallTurns(callSid).length, 1, "wpis wciąż istnieje");

    const oneHourAhead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const deleted = deleteCallTurnsBefore(oneHourAhead);
    assert.equal(deleted, 1, "granica w przyszłości musi złapać dokładnie ten jeden wpis w izolowanej bazie");
    assert.equal(getCallTurns(callSid).length, 0, "wpis został usunięty");
  });

  test("SMS sprzed daty granicznej znika, świeży zostaje nietknięty", () => {
    const phone = "+48600000001";
    logSmsMessage({ direction: "in", clientPhone: phone, body: "test", dedupeKey: "purge-sms-test" });

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    assert.equal(deleteSmsMessagesBefore(oneHourAgo), 0);
    assert.equal(getSmsThread(phone).length, 1);

    const oneHourAhead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const deleted = deleteSmsMessagesBefore(oneHourAhead);
    assert.equal(deleted, 1);
    assert.equal(getSmsThread(phone).length, 0);
  });
});
