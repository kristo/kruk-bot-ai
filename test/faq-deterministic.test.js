const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

require("dotenv").config();
const salonConfig = require("../src/config/salon");
const { answerFaqDeterministic } = require("../src/services/faq");

// Zasada nadrzędna tego modułu: lepiej oddać pytanie do AI (null) niż odpowiedzieć źle.
// Testy są więc podzielone na "musi odpowiedzieć natychmiast" i "musi się wstrzymać".

describe("FAQ bez AI — godziny otwarcia", () => {
  test("pytanie ogólne podaje wszystkie trzy przedziały", () => {
    const answer = answerFaqDeterministic("jakie macie godziny otwarcia");
    assert.match(answer, /8:00 do 20:00/);
    assert.match(answer, /8:00 do 16:00/);
    assert.match(answer, /niedziel/i);
  });

  test("pytanie o konkretny dzień podaje tylko ten dzień", () => {
    assert.match(answerFaqDeterministic("o której zamykacie w soboty"), /W soboty pracujemy od 8:00 do 16:00/);
    assert.match(answerFaqDeterministic("czy w niedzielę jesteście otwarci"), /W niedziele mamy nieczynne/);
  });

  test("odmiana przyimka jest poprawna — 'we wtorki', nie 'w wtorki'", () => {
    const answer = answerFaqDeterministic("czy we wtorek jesteście czynni");
    assert.match(answer, /We wtorki/);
    assert.doesNotMatch(answer, /W wtorki/);
  });

  test("'dzisiaj' odpowiada godzinami na dziś (czas warszawski)", () => {
    const answer = answerFaqDeterministic("czy dzisiaj jesteście czynni");
    const todayName = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", weekday: "short" }).format(new Date());
    const expectClosed = todayName === "Sun";
    if (expectClosed) assert.match(answer, /nieczynne/);
    else assert.match(answer, /pracujemy od/);
  });

  test("odmienione formy dni są rozpoznawane", () => {
    for (const phrase of [
      "czy w sobotę pracujecie",
      "o której otwieracie w poniedziałek",
      "jakie macie godziny w piątki",
    ]) {
      const answer = answerFaqDeterministic(phrase);
      assert.ok(answer, `powinno odpowiedzieć natychmiast: ${phrase}`);
      assert.match(answer, /pracujemy od/);
    }
  });

  test("'pracujecie' bez wskazania dnia to NIE jest pytanie o godziny", () => {
    // "na jakich kosmetykach pracujecie?" dostawało wcześniej odpowiedź o godzinach otwarcia.
    assert.equal(answerFaqDeterministic("na jakich kosmetykach pracujecie"), null);
    assert.equal(answerFaqDeterministic("jakimi technikami pracujecie"), null);
  });

  test("wieloznaczne pytanie o dzień idzie do AI", () => {
    // "jak jest w soboty" może dotyczyć godzin, ale równie dobrze tego, czy jest tłoczno.
    assert.equal(answerFaqDeterministic("jak jest w soboty"), null);
  });

  test("pytanie o dwa różne dni naraz idzie do AI", () => {
    assert.equal(answerFaqDeterministic("jak pracujecie w soboty i niedziele"), null);
  });

  test("godziny są wspólne dla sieci, więc pytanie o konkretny salon też dostaje odpowiedź", () => {
    // Zabezpieczenie: gdyby kiedyś doszły godziny per lokalizacja, ten test trzeba odwrócić,
    // a moduł sam zacznie takie pytania oddawać do AI (patrz hasPerLocationHours).
    assert.equal(
      (salonConfig.locations || []).some((l) => l.hours),
      false,
      "konfiguracja ma teraz godziny per salon — logika FAQ wymaga przeglądu"
    );
    assert.match(answerFaqDeterministic("o której zamykacie na Urzędniczej"), /pracujemy od/);
  });
});

describe("FAQ bez AI — ceny", () => {
  test("konkretna usługa dostaje swoją cenę i czas", () => {
    assert.match(answerFaqDeterministic("ile kosztuje strzyżenie"), /90 złotych/);
    assert.match(answerFaqDeterministic("ile kosztuje sama broda"), /70 złotych/);
    assert.match(answerFaqDeterministic("ile kosztuje buzzcut"), /75 złotych/);
    assert.match(answerFaqDeterministic("ile kosztuje strzyżenie dziecka"), /85 złotych/);
  });

  test("usługa złożona nie łapie się na cenę składnika", () => {
    // "strzyżenie z brodą" NIE może zwrócić 90 zł za samo strzyżenie.
    const answer = answerFaqDeterministic("ile kosztuje strzyżenie z brodą");
    assert.match(answer, /130 złotych/);
    assert.doesNotMatch(answer, /90 złotych/);
  });

  test("skróty z cennika są rozwinięte do słów czytelnych dla TTS", () => {
    const answer = answerFaqDeterministic("ile kosztuje strzyżenie");
    assert.match(answer, /90 złotych/);
    assert.match(answer, /45 minut/);
    // Uwaga na \b po polskich znakach: /\bzł\b/ dopasowuje się do ŚRODKA słowa "złotych",
    // bo "ł" nie jest znakiem ASCII i granica słowa wypada zaraz po nim. Stąd jawne wykluczenie.
    assert.doesNotMatch(answer, /\d+\s*zł(?![a-ząćęłńóśźż])/);
    assert.doesNotMatch(answer, /\d+\s*min(?![a-ząćęłńóśźż])/);
  });

  test("pytanie o cennik ogólnie podaje trzy najpopularniejsze, nie listę 19 pozycji", () => {
    const answer = answerFaqDeterministic("jaki macie cennik");
    assert.match(answer, /90 złotych/);
    assert.match(answer, /Booksy/);
    assert.ok(answer.split(/[.!?]/).filter(Boolean).length <= 3, "odpowiedź ma być krótka");
  });

  test("tonowanie ma pięć wariantów cenowych, więc idzie do AI", () => {
    assert.equal(answerFaqDeterministic("ile kosztuje tonowanie"), null);
  });

  test("usługa spoza oferty idzie do AI", () => {
    assert.equal(answerFaqDeterministic("ile kosztuje farbowanie włosów"), null);
  });
});

describe("FAQ bez AI — vouchery i liczba salonów", () => {
  test("voucher dostaje krótką odpowiedź zamiast długiego akapitu z konfiguracji", () => {
    const answer = answerFaqDeterministic("czy macie vouchery na prezent");
    assert.match(answer, /voucher/i);
    assert.ok(answer.split(/\s+/).length < 40, "odpowiedź przez telefon musi być krótka");
  });

  test("liczba salonów zgadza się z konfiguracją", () => {
    const answer = answerFaqDeterministic("ile macie salonów");
    assert.match(answer, new RegExp(String(salonConfig.declaredBranchCount)));
  });

  test("pytanie o salony w konkretnej dzielnicy idzie do AI", () => {
    assert.equal(answerFaqDeterministic("gdzie jesteście na Krowodrzy"), null);
  });
});

describe("FAQ bez AI — wstrzymanie się w razie wątpliwości", () => {
  test("dwa tematy naraz idą do AI", () => {
    assert.equal(answerFaqDeterministic("jakie macie godziny w soboty i ile kosztuje strzyżenie"), null);
    assert.equal(answerFaqDeterministic("ile kosztuje strzyżenie i czy macie vouchery"), null);
  });

  test("temat spoza obsługiwanych idzie do AI", () => {
    assert.equal(answerFaqDeterministic("jaki macie parking"), null);
    assert.equal(answerFaqDeterministic("na jakich kosmetykach pracujecie"), null);
    assert.equal(answerFaqDeterministic("czy mogę przyjść z psem"), null);
  });

  test("wypowiedź, która nie jest pytaniem FAQ, idzie do AI", () => {
    assert.equal(answerFaqDeterministic("chcę się umówić na jutro"), null);
    assert.equal(answerFaqDeterministic("spóźnię się dziesięć minut"), null);
    assert.equal(answerFaqDeterministic(""), null);
    assert.equal(answerFaqDeterministic(null), null);
  });
});

describe("FAQ bez AI — odporność na zapis bez polskich znaków", () => {
  test("rozpoznawanie mowy bez ogonków daje ten sam wynik", () => {
    assert.match(answerFaqDeterministic("ile kosztuje strzyzenie"), /90 złotych/);
    assert.match(answerFaqDeterministic("o ktorej zamykacie w sobote"), /8:00 do 16:00/);
  });
});
