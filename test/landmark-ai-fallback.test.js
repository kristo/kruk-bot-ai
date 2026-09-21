const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

require("dotenv").config();
const { matchLandmarkToSalon } = require("../src/services/ai");
const salonConfig = require("../src/config/salon");

// Fallback dla PRAWDZIWYCH landmarków spoza naszej ręcznie prowadzonej listy w salon.js —
// od Krzysztofa, 18.09.2026: "bot często nie zna punktów orientacyjnych Krakowa... łatwo
// o pomyłkę". Testy tutaj celowo NIE zakładają, że model trafnie zna geografię Krakowa co do
// metra (to prawdziwe wywołanie AI, więc jego wiedza geograficzna nie jest czymś, co ten pakiet
// testów powinien arbitrażować) — sprawdzają za to WŁAŚCIWOŚCI BEZPIECZEŃSTWA, które obowiązują
// niezależnie od trafności: funkcja nigdy nie wymyśla salonu spoza listy, i uczciwie zwraca
// "nie wiem" zamiast zgadywać przy braku sygnału. To właśnie ta gwarancja odróżnia ten pomysł od
// wcześniej odrzuconego "AI wybiera salon samo" (patrz findLocationMatch w voice.js).
describe("matchLandmarkToSalon — bezpieczeństwo, nie dokładność geograficzna", () => {
  test("wypowiedź bez żadnego realnego miejsca w Krakowie daje null", async () => {
    const result = await matchLandmarkToSalon("chcę się zapisać, no wiecie, standardowo", salonConfig.locations);
    assert.equal(result, null);
  });

  test("kompletnie wymyślone, nieistniejące miejsce daje null, nie zgaduje 'na oślep'", async () => {
    const result = await matchLandmarkToSalon(
      "jestem koło fikcyjnego placu Zzzyxwvutysrqponcelemplem, którego na pewno nie ma w Krakowie",
      salonConfig.locations
    );
    assert.equal(result, null);
  });

  test("gdy zwraca wynik, to ZAWSZE dokładnie jedna z prawdziwych nazw salonów — nigdy nic wymyślonego", async () => {
    // Prawdziwe, rozpoznawalne miejsce w Krakowie, którego celowo NIE ma w żadnej liście
    // landmarków w salon.js (zweryfikowane niżej) — model ma spore pole, żeby się pomylić co do
    // KTÓREGO salonu wybrać, ale niezależnie od trafu, wynik musi być z naszej listy albo null.
    const speech = "jestem w okolicy Rynku Głównego, koło Sukiennic";
    const result = await matchLandmarkToSalon(speech, salonConfig.locations);

    if (result !== null) {
      const names = salonConfig.locations.map((l) => l.name);
      assert.ok(names.includes(result), `wynik "${result}" musi być dokładną nazwą z listy salonów`);
    }
    // brak asercji o KONKRETNYM salonie — to już kwestia wiedzy geograficznej modelu, nie
    // czegoś, co ten test powinien wymuszać.
  });

  test("pusta wypowiedź albo brak listy salonów nie wywołuje AI, od razu null", async () => {
    assert.equal(await matchLandmarkToSalon("", salonConfig.locations), null);
    assert.equal(await matchLandmarkToSalon(null, salonConfig.locations), null);
    assert.equal(await matchLandmarkToSalon("jakaś wypowiedź", []), null);
    assert.equal(await matchLandmarkToSalon("jakaś wypowiedź", null), null);
  });

  test("użyty landmark testowy faktycznie nie jest już nigdzie ręcznie skonfigurowany", () => {
    // Kontrola założenia powyższego testu: gdyby "Rynek Główny"/"Sukiennice" trafiły kiedyś do
    // salon.js jako landmark, ten test przestałby faktycznie sprawdzać NOWY fallback (bo
    // deterministyczny matcher złapałby to wcześniej, zanim AI w ogóle zostałoby wywołane).
    const allLandmarks = salonConfig.locations.flatMap((l) => l.landmarks || []).join(" | ").toLowerCase();
    assert.doesNotMatch(allLandmarks, /rynek gł[oó]wny|sukiennice/i);
  });
});
