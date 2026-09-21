const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

require("dotenv").config();
const voiceRouter = require("../src/routes/voice");
const { isDeclinedAnswer } = voiceRouter._test;

// Regexy "dodatkowe", dokładnie takie, jakich używają trasy potwierdzające w voice.js.
const LOCATION_EXTRA = /(zły salon|zła lokalizacj|inny salon|pomyliłe)/i;
const HANDOFF_EXTRA = /(nieważne|anuluj|zrezygnuj|daj spokój|zostaw)/i;

describe("isDeclinedAnswer — gołe 'nie' na pytanie zamknięte", () => {
  // Właściwy błąd znaleziony w przeglądzie 15.09.2026: poprzedni wzorzec nie[\s,.] wymagał znaku
  // PO słowie "nie", więc samo "Nie" (tak zwraca rozpoznawanie mowy, bez kropki) przechodziło
  // jako POTWIERDZENIE — bot wysyłał zgłoszenie mimo odmowy albo kierował je do odrzuconego salonu.
  test("samo 'Nie' to odmowa", () => {
    assert.equal(isDeclinedAnswer("Nie", LOCATION_EXTRA), true);
    assert.equal(isDeclinedAnswer("nie", LOCATION_EXTRA), true);
  });

  test("'no nie' to odmowa", () => {
    assert.equal(isDeclinedAnswer("no nie", LOCATION_EXTRA), true);
  });

  test("warianty z interpunkcją i rozwinięciem nadal są odmową", () => {
    for (const answer of ["nie.", "Nie!", "nie, to nie ten", "nie ten", "nie chcę", "nie o ten mi chodziło"]) {
      assert.equal(isDeclinedAnswer(answer, LOCATION_EXTRA), true, `powinno być odmową: ${answer}`);
    }
  });
});

describe("isDeclinedAnswer — potwierdzenia NIE mogą być mylone z odmową", () => {
  test("'Tak' i jego warianty to potwierdzenie", () => {
    for (const answer of ["Tak", "tak, dokładnie", "zgadza się", "owszem", "jasne", "dokładnie tak"]) {
      assert.equal(isDeclinedAnswer(answer, LOCATION_EXTRA), false, `powinno być potwierdzeniem: ${answer}`);
    }
  });

  test("potwierdzenie z wyjaśnieniem zawierającym 'nie' nie jest odmową", () => {
    // "nie" liczy się tylko na POCZĄTKU wypowiedzi — tam pada odpowiedź na pytanie.
    assert.equal(isDeclinedAnswer("Tak, bo nie mogę się dodzwonić", HANDOFF_EXTRA), false);
    assert.equal(isDeclinedAnswer("tak, nie zdążę inaczej", HANDOFF_EXTRA), false);
  });

  test("'nie ma sprawy' znaczy 'tak' mimo słowa 'nie'", () => {
    assert.equal(isDeclinedAnswer("nie ma sprawy", HANDOFF_EXTRA), false);
    assert.equal(isDeclinedAnswer("nie ma problemu", HANDOFF_EXTRA), false);
  });

  test("słowo 'mnie' i nazwa salonu 'Niepodległości' nie są odmową", () => {
    // Stary wzorzec nie[\s,.] łapał "mnie, " i podobne w środku wypowiedzi.
    assert.equal(isDeclinedAnswer("dla mnie tak", LOCATION_EXTRA), false);
    assert.equal(isDeclinedAnswer("tak, Niepodległości", LOCATION_EXTRA), false);
  });

  test("cisza nie jest odmową (celowo — lepiej zgłosić niż zgubić zgłoszenie)", () => {
    assert.equal(isDeclinedAnswer("", LOCATION_EXTRA), false);
    assert.equal(isDeclinedAnswer(null, LOCATION_EXTRA), false);
  });
});

describe("isDeclinedAnswer — frazy specyficzne dla trasy", () => {
  test("odmowa lokalizacji bez słowa 'nie'", () => {
    assert.equal(isDeclinedAnswer("zły salon", LOCATION_EXTRA), true);
    assert.equal(isDeclinedAnswer("pomyliłeś się, inny salon", LOCATION_EXTRA), true);
  });

  test("rezygnacja ze zgłoszenia bez słowa 'nie'", () => {
    assert.equal(isDeclinedAnswer("anuluj to", HANDOFF_EXTRA), true);
    assert.equal(isDeclinedAnswer("nieważne", HANDOFF_EXTRA), true);
  });

  test("fraza z jednej trasy nie działa w drugiej (regexy są rozdzielne)", () => {
    assert.equal(isDeclinedAnswer("zły salon", HANDOFF_EXTRA), false);
  });
});

// Obieg po odpowiedzi FAQ wg Wiktorii (16.09.2026): "zapytać czy klient dostał satysfakcjonującą
// odpowiedź, i jeśli nie to wtedy że ja zadzwonię, a jak tak albo się nie odezwie to temat zamknięty".
// Pułapka: "nie, dziękuję" i "nie, to mi nie wystarczy" zaczynają się tak samo, a znaczą co innego.
describe("classifyFaqFollowup — czy odpowiedź była wyczerpująca", () => {
  const { classifyFaqFollowup } = voiceRouter._test;

  test("zadowolenie zamyka temat", () => {
    for (const answer of ["Tak", "tak, dziękuję", "ok", "jasne", "to mi wystarczy", "w porządku"]) {
      assert.equal(classifyFaqFollowup(answer), "zamknij", `powinno zamykać: ${answer}`);
    }
  });

  test("cisza zamyka temat (klient się rozłączył albo nie ma nic więcej)", () => {
    assert.equal(classifyFaqFollowup(""), "zamknij");
    assert.equal(classifyFaqFollowup(null), "zamknij");
  });

  test("grzeczne podziękowanie zamyka temat, nawet zaczynając od 'nie'", () => {
    assert.equal(classifyFaqFollowup("Nie, dziękuję"), "zamknij");
    assert.equal(classifyFaqFollowup("nie, dzięki"), "zamknij");
  });

  test("niezadowolenie kieruje do Wiktorii", () => {
    for (const answer of ["Nie", "nie bardzo", "nie, to mi nie wystarczy", "to nie odpowiada na moje pytanie", "nadal nie wiem"]) {
      assert.equal(classifyFaqFollowup(answer), "oddzwon", `powinno kierować do Wiktorii: ${answer}`);
    }
  });

  test("'nie wystarczy' NIE może zostać wzięte za zadowolenie", () => {
    // Fraza zawiera słowo "wystarczy", które osobno oznacza zadowolenie — negacja musi wygrać.
    assert.equal(classifyFaqFollowup("to mi nie wystarczy"), "oddzwon");
    assert.notEqual(classifyFaqFollowup("to mi nie wystarczy"), "zamknij");
  });

  test("kolejne pytanie nie jest ani zamknięciem, ani prośbą o telefon", () => {
    assert.equal(classifyFaqFollowup("a ile kosztuje broda"), "pytanie");
    assert.equal(classifyFaqFollowup("chciałbym się jeszcze umówić"), "pytanie");
  });
});
