const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

require("dotenv").config();
const voiceRouter = require("../src/routes/voice");
const { detectIntent, resolveIntent } = voiceRouter._test;

describe("detectIntent — SPOZNIENIE (regex szybkiej ścieżki, bez AI)", () => {
  test("łapie wprost słowo 'późn'", () => {
    assert.equal(detectIntent("Spóźnię się na wizytę"), "SPOZNIENIE");
  });

  test("łapie pośrednie sygnały spóźnienia bez słowa 'późn'", () => {
    assert.equal(detectIntent("utknąłem w korku, nie zdążę na czas"), "SPOZNIENIE");
    assert.equal(detectIntent("auto mi się popsuło, dojadę z opóźnieniem"), "SPOZNIENIE");
    assert.equal(detectIntent("coś mi wypadło, będę później"), "SPOZNIENIE");
  });

  test("SPOZNIENIE ma pierwszeństwo nad ZAPIS, gdy oba sygnały występują naraz", () => {
    // Realny przypadek z 08.09.2026: "umówiłem się wcześniej, coś mi wypadło, nie zdążę" —
    // zawiera "umówi" (ZAPIS) ale to zgłoszenie spóźnienia, nie chęć zapisu.
    assert.equal(
      detectIntent("umówiłem się wcześniej ale coś mi wypadło i pewnie nie zdążę na czas"),
      "SPOZNIENIE"
    );
  });
});

describe("detectIntent — ZAPIS", () => {
  test("łapie typowe frazy o umówieniu nowej wizyty", () => {
    assert.equal(detectIntent("Chcę się umówić na jutro"), "ZAPIS");
    assert.equal(detectIntent("Czy jest wolny termin w tym tygodniu"), "ZAPIS");
    assert.equal(detectIntent("Chcę się zapisać"), "ZAPIS");
  });
});

describe("detectIntent — odwołanie/zmiana wizyty to INNE, nie ZAPIS", () => {
  test("'zmienić termin' nie łapie się na regex ZAPIS mimo słowa 'termin'", () => {
    assert.equal(detectIntent("Muszę zmienić termin wizyty"), "INNE");
  });

  test("odwołanie wizyty to INNE", () => {
    assert.equal(detectIntent("Chcę odwołać wizytę"), "INNE");
    assert.equal(detectIntent("Chciałbym anulować rezerwację"), "INNE");
  });
});

// Od Wiktorii/Damiana, 17.09.2026: telefony firm oferujących coś salonowi (kosmetyki, sprzątanie)
// mają być rozpoznane osobno, żeby bot nie obiecywał oddzwonienia na coś, co Wiktoria i tak
// zwykle ignoruje ("żebym wiedziała że nie muszę oddzwaniać").
describe("detectIntent — WSPOLPRACA (telefony B2B, nie klienci)", () => {
  test("łapie wprost słowo 'współpraca' w różnych formach", () => {
    assert.equal(detectIntent("Dzwonię w sprawie współpracy"), "WSPOLPRACA");
    assert.equal(detectIntent("Chciałbym zaproponować Państwu współpracę"), "WSPOLPRACA");
    assert.equal(detectIntent("Jesteśmy zainteresowani nawiązaniem współpracy z salonem"), "WSPOLPRACA");
  });

  test("łapie przedstawienie się jako firma", () => {
    assert.equal(detectIntent("Dzień dobry, reprezentuję firmę kosmetyczną"), "WSPOLPRACA");
  });

  test("pytanie klienta o ofertę usług NIE jest mylone ze współpracą B2B", () => {
    // "oferta" samo w sobie jest już w FAQ_KEYWORDS_REGEX (klient pytający o usługi salonu) —
    // COOPERATION_REGEX celowo NIE zawiera samego "ofert", żeby tego nie kolidować.
    assert.equal(detectIntent("Jaka jest wasza oferta na strzyżenie"), "PYTANIE");
    assert.equal(detectIntent("Pytam o waszą pełną ofertę"), "PYTANIE");
  });
});

describe("detectIntent — PYTANIE (FAQ)", () => {
  test("łapie pytania o godziny, cennik, adres", () => {
    assert.equal(detectIntent("Jakie macie godziny otwarcia"), "PYTANIE");
    assert.equal(detectIntent("Ile kosztuje strzyżenie brody"), "PYTANIE");
    assert.equal(detectIntent("Jaki jest adres salonu"), "PYTANIE");
  });

  test("łapie potoczne 'Huta'/'Hucie' bez słowa 'Nowa'", () => {
    assert.equal(detectIntent("Jakie są salony w hucie"), "PYTANIE");
  });
});

describe("detectIntent — INNE (domyślne)", () => {
  test("zwraca INNE, gdy nic nie pasuje", () => {
    assert.equal(detectIntent("chciałbym się poskarżyć na fryzurę"), "INNE");
  });

  test("zwraca INNE dla pustej wypowiedzi", () => {
    assert.equal(detectIntent(""), "INNE");
    assert.equal(detectIntent(undefined), "INNE");
  });
});

describe("resolveIntent — odwołanie jest rozstrzygane BEZ wołania AI", () => {
  test("zwraca INNE natychmiast (bez sieciowego wywołania) dla frazy odwołania", async () => {
    // Ten test celowo nie mockuje classifyIntent — jeśli CANCELLATION_REGEX przestanie działać
    // jako skrót przed AI, ten test i tak przejdzie (bo AI też powinno zwrócić INNE), ale będzie
    // zauważalnie wolniejszy / wymagał sieci. Mierzymy czas jako słaby sygnał regresji.
    const start = Date.now();
    const result = await resolveIntent("Chcę odwołać wizytę");
    const elapsedMs = Date.now() - start;
    assert.equal(result, "INNE");
    assert.ok(elapsedMs < 200, `spodziewano się rozstrzygnięcia bez sieci (<200ms), zajęło ${elapsedMs}ms`);
  });
});
