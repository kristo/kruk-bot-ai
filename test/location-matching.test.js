const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

require("dotenv").config();
const voiceRouter = require("../src/routes/voice");
const salonConfig = require("../src/config/salon");
const { findLocationMatchDeterministic, wordFormsMatch, tokenizeForMatch } = voiceRouter._test;

const novaHutaCount = salonConfig.locations.filter((l) =>
  l.district.toLowerCase().includes("nowa huta")
).length;

describe("findLocationMatchDeterministic — dopasowanie jednoznaczne", () => {
  test("pełna nazwa ulicy", () => {
    const { match, candidates } = findLocationMatchDeterministic("Urzędnicza 48");
    assert.equal(match.name, "Urzędnicza 48");
    assert.equal(candidates.length, 0);
  });

  test("alias (odmiana/zapis bez ogonków)", () => {
    const { match } = findLocationMatchDeterministic("wroclawska 60");
    assert.equal(match.name, "Wrocławska 60");
  });

  test("jedyny salon na danej ulicy rozpoznany przez sam rdzeń nazwy", () => {
    const { match, candidates } = findLocationMatchDeterministic("jestem umówiony na Urzędniczej");
    assert.equal(match.name, "Urzędnicza 48");
    assert.equal(candidates.length, 0);
  });
});

describe("findLocationMatchDeterministic — niejednoznaczność", () => {
  // Od 21.09.2026 (nowa baza ulic/landmarków od Krzysztofa) ul. Wrocławska jest jednym z kandydatów
  // także dla Prądnickiej 77 (leży przy tej samej, długiej ulicy) — trzy kandydaci, nie dwa.
  test("sama nazwa ulicy współdzielona przez TRZY salony daje kandydatów, nie dopasowanie", () => {
    const { match, candidates } = findLocationMatchDeterministic("Wrocławska");
    assert.equal(match, null);
    assert.equal(candidates.length, 3);
    const names = candidates.map((c) => c.name).sort();
    assert.deepEqual(names, ["Prądnicka 77", "Wrocławska 5A", "Wrocławska 60"]);
  });
});

describe("findLocationMatchDeterministic — Nowa Huta, potoczne formy i odmiana", () => {
  for (const phrase of ["Nowa Huta", "w Nowej Hucie", "z Nowej Huty", "Nową Hutą", "w hucie", "na hucie", "Nową Hutę"]) {
    test(`"${phrase}" daje ${novaHutaCount} kandydatów (dzielnica Nowa Huta)`, () => {
      const { match, candidates } = findLocationMatchDeterministic(phrase);
      assert.equal(match, null, "kilka salonów w Nowej Hucie — nie powinno dopasować jednego na ślepo");
      assert.equal(candidates.length, novaHutaCount);
    });
  }

  test("otoczenie dodatkowymi słowami nie psuje dopasowania dzielnicy", () => {
    const { candidates } = findLocationMatchDeterministic(
      "no więc chodzi mi o Nową Hutę, bo tam mieszkam"
    );
    assert.equal(candidates.length, novaHutaCount);
  });
});

describe("findLocationMatchDeterministic — punkty orientacyjne (landmarks)", () => {
  test("jednoznaczny landmark zwraca dopasowanie z flagą viaLandmark", () => {
    const { match, viaLandmark, candidates } = findLocationMatchDeterministic("jestem koło Muzeum Lotnictwa");
    assert.equal(match.name, "Dywizjonu 303 31E");
    assert.equal(viaLandmark, true);
    assert.equal(candidates.length, 0);
  });

  // "Andersa" NIE jest już tu użyte jako przykład jednoznacznego landmarku — od 21.09.2026
  // (nowa baza ulic/landmarków) al. Andersa biegnie koło Dywizjonu 303 I Niepodległości 3A,
  // więc słusznie daje dwóch kandydatów, nie ciche trafienie w jeden salon.
  test("landmark dzielony przez dwa salony (al. Andersa) daje kandydatów, nie ciche trafienie", () => {
    const { match, candidates } = findLocationMatchDeterministic("jestem koło Andersa");
    assert.equal(match, null);
    const names = candidates.map((c) => c.name).sort();
    assert.deepEqual(names, ["Dywizjonu 303 31E", "Niepodległości 3A"]);
  });
});

describe("findLocationMatchDeterministic — brak sygnału", () => {
  test("zwraca null i pustą listę kandydatów, gdy nic nie pasuje", () => {
    const { match, candidates } = findLocationMatchDeterministic("chcę się tylko zapisać");
    assert.equal(match, null);
    assert.equal(candidates.length, 0);
  });

  test("pusta wypowiedź nie wybucha", () => {
    const { match, candidates } = findLocationMatchDeterministic("");
    assert.equal(match, null);
    assert.equal(candidates.length, 0);
  });
});

// Pytanie o obszar przy spóźnieniu — od Wiktorii, 16.09.2026 ("może jakby zapytał
// huta/centrum/krowodrza i później zawężał").
describe("Zawężanie obszarem przy spóźnieniu", () => {
  const { LATE_AREA_PROMPT } = voiceRouter._test;

  // Nazwy obszarów wymienione w pytaniu, dokładnie w formie, w jakiej odpowie klient.
  // "na Prądniku Czerwonym" dodane 21.09.2026, razem z rozszerzeniem LATE_AREA_PROMPT.
  const AREA_ANSWERS = ["w Nowej Hucie", "na Krowodrzy", "w centrum", "na Dębnikach", "na Prądniku Czerwonym"];

  function reachableFrom(answer) {
    const { match, candidates } = findLocationMatchDeterministic(answer);
    return match ? [match] : candidates;
  }

  test("każdy obszar z pytania prowadzi do co najmniej jednego salonu", () => {
    for (const answer of AREA_ANSWERS) {
      assert.ok(reachableFrom(answer).length > 0, `"${answer}" nie wskazuje żadnego salonu`);
    }
  });

  test("obszary z pytania pokrywają WSZYSTKIE salony — żaden nie jest nieosiągalny", () => {
    // Gdyby doszedł salon w nowej dzielnicy, ten test przypomni o uzupełnieniu LATE_AREA_PROMPT.
    const reachable = new Set(AREA_ANSWERS.flatMap((a) => reachableFrom(a).map((l) => l.name)));
    const missing = salonConfig.locations.map((l) => l.name).filter((name) => !reachable.has(name));
    assert.deepEqual(missing, [], `salony nieosiągalne z pytania o obszar: ${missing.join(", ")}`);
  });

  test("każdy obszar wymieniony w pytaniu jest rozpoznawany przez matcher", () => {
    for (const area of ["Nowej Hucie", "Krowodrzy", "centrum", "Dębnikach", "Prądniku Czerwonym"]) {
      assert.match(LATE_AREA_PROMPT, new RegExp(area), `pytanie nie wymienia obszaru ${area}`);
    }
  });

  test("'w centrum' daje wybór, a nie cichy strzał w jeden salon", () => {
    const { match, candidates } = findLocationMatchDeterministic("jestem umówiony w centrum");
    assert.equal(match, null);
    assert.ok(candidates.length >= 2, "centrum powinno dawać kilku kandydatów");
  });

  // Zgłoszone przez Damiana, 17.09.2026: mówiąc dokładnie tak, jak podpowiada LATE_AREA_PROMPT
  // ("w centrum"), dostawał tylko Wrocławską 60 i Urzędniczą — Wrocławska 5A i Prądnicka 77 (obie
  // mają w konfiguracji samo "Krowodrza", nie "centrum"/"Stare Miasto") po cichu wypadały z listy,
  // mimo że leżą w tej samej, centralnej części miasta.
  test("'w centrum' obejmuje WSZYSTKIE salony z Krowodrzy, nie tylko te z 'centrum' w nazwie dzielnicy", () => {
    const { candidates } = findLocationMatchDeterministic("jestem umówiony w centrum");
    const names = candidates.map((l) => l.name);
    assert.ok(names.includes("Wrocławska 60"), "brakuje Wrocławskiej 60");
    assert.ok(names.includes("Urzędnicza 48"), "brakuje Urzędniczej 48");
    assert.ok(names.includes("Wrocławska 5A"), "brakuje Wrocławskiej 5A — zgłoszenie Damiana 17.09.2026");
    assert.ok(names.includes("Prądnicka 77"), "brakuje Prądnickiej 77");
  });

  test("potoczne nazwy centrum też działają", () => {
    for (const phrase of ["na starówce", "w śródmieściu", "na starym mieście"]) {
      const { match, candidates } = findLocationMatchDeterministic(phrase);
      assert.ok(match || candidates.length > 0, `"${phrase}" nie wskazuje żadnego salonu`);
    }
  });

  test("liczba salonów zniknęła z pytania o obszar — 'kilka lokalizacji' zamiast konkretnej liczby", () => {
    // Od Damiana, 17.09.2026: podawanie liczby, a zaraz potem tylko 4 obszarów, brzmiało niespójnie.
    assert.doesNotMatch(LATE_AREA_PROMPT, /\d/);
    assert.match(LATE_AREA_PROMPT, /kilka lokalizacji/);
  });
});

// Zgłoszone przez Damiana, 17.09.2026: "Prądnik Czerwony" (dzielnica, landmark Kniaźniny 1)
// trafiał PO CICHU, bez pytania o potwierdzenie, do Prądnickiej 77 — bo rdzeń ulicy "Prądnicka"
// (po automatycznym obcięciu końcówki: "prądni") jest przypadkowym podciągiem słowa "prądnik".
describe("Prądnik Czerwony vs Prądnicka — kolizja rdzenia ulicy z nazwą dzielnicy", () => {
  test("'Prądnik Czerwony' wskazuje na Kniaźninę 1, z prośbą o potwierdzenie (landmark)", () => {
    const { match, viaLandmark } = findLocationMatchDeterministic("Prądnik Czerwony");
    assert.equal(match?.name, "Kniaźnina 1");
    assert.equal(viaLandmark, true, "landmark musi wymagać potwierdzenia, nie być cichym, pewnym trafieniem");
  });

  test("odmienione formy 'Prądnik Czerwony' też trafiają w Kniaźninę 1", () => {
    for (const phrase of ["na Prądniku Czerwonym", "koło Prądnika Czerwonego", "na Pradniku Czerwonym"]) {
      const { match, viaLandmark } = findLocationMatchDeterministic(phrase);
      assert.equal(match?.name, "Kniaźnina 1", `"${phrase}" powinno wskazywać Kniaźninę 1`);
      assert.equal(viaLandmark, true, `"${phrase}" powinno wymagać potwierdzenia`);
    }
  });

  test("sama 'Prądnicka' (bez 'Czerwony') nadal pewnie wskazuje Prądnicką 77", () => {
    for (const phrase of ["Prądnicka", "na Prądnickiej", "jestem na Prądnickiej 77"]) {
      const { match, viaLandmark } = findLocationMatchDeterministic(phrase);
      assert.equal(match?.name, "Prądnicka 77", `"${phrase}" powinno wskazywać Prądnicką 77`);
      assert.equal(viaLandmark, false, `"${phrase}" to pewne dopasowanie po nazwie ulicy, nie landmark`);
    }
  });
});

// Rozszerzona baza ulic/punktów orientacyjnych — od Krzysztofa, 21.09.2026 (patrz komentarz nad
// tablicą lokalizacji w salon.js). Dwa rodzaje sprawdzeń: (1) ulice/punkty leżące blisko WIĘCEJ NIŻ
// JEDNEGO salonu muszą dawać kandydatów do wyboru, nigdy ciche trafienie w jeden z nich;
// (2) typowe polskie odmiany przez przypadki ("przy Placu X", "w Parku X", "koło szpitala X") mają
// być rozpoznawane, bo tak faktycznie mówią dzwoniący — nie tylko w mianowniku.
describe("Rozszerzona baza lokalizacji (21.09.2026) — ulice/landmarki dzielone przez kilka salonów", () => {
  const SHARED_CASES = [
    ["jestem przy Placu Inwalidów", ["Urzędnicza 48", "Wrocławska 5A", "Wrocławska 60"]],
    ["jestem koło Bora-Komorowskiego", ["Dywizjonu 303 31E", "Kniaźnina 1"]],
    ["jestem koło Andersa", ["Dywizjonu 303 31E", "Niepodległości 3A"]],
    ["jestem na Osiedlu Piastów", ["Bohaterów Września 1E", "Kniaźnina 1"]],
    ["jestem koło szpitala Rydygiera", ["Bohaterów Września 1E", "Kniaźnina 1"]],
    ["jestem w Parku Krakowskim", ["Urzędnicza 48", "Wrocławska 60"]],
  ];

  for (const [phrase, expectedNames] of SHARED_CASES) {
    test(`"${phrase}" daje kandydatów (${expectedNames.join(", ")}), nie ciche trafienie w jeden salon`, () => {
      const { match, candidates } = findLocationMatchDeterministic(phrase);
      assert.equal(match, null, `"${phrase}" nie powinno dawać pewnego dopasowania — kilka salonów tam pasuje`);
      assert.deepEqual(candidates.map((c) => c.name).sort(), [...expectedNames].sort());
    });
  }

  // Ulica biegnąca koło trzech salonów naraz (60, 5A i Prądnicka 77) — najbardziej rozbudowany
  // przypadek niejednoznaczności w bazie.
  test("'Wrocławska' bez numeru daje TRZECH kandydatów, w tym Prądnicką 77", () => {
    const { candidates } = findLocationMatchDeterministic("jestem na Wrocławskiej");
    assert.deepEqual(
      candidates.map((c) => c.name).sort(),
      ["Prądnicka 77", "Wrocławska 5A", "Wrocławska 60"]
    );
  });

  // Odmiana przez przypadki dla punktów orientacyjnych dodanych 21.09.2026 — bez tego bot rozumiał
  // tylko sztywny mianownik ("Plac Centralny"), a nie naturalną formę po "przy"/"w"/"koło", którą
  // ludzie faktycznie mówią.
  const DECLINED_CASES = [
    ["jestem przy Placu Centralnym", "Niepodległości 3A"],
    ["jestem przy Rondzie Kocmyrzowskim", "Niepodległości 3A"],
    ["jestem koło Zalewu Nowohuckiego", "Niepodległości 3A"],
    ["jestem koło szpitala Żeromskiego", "Niepodległości 3A"],
    ["jestem na Kapelance", "Komandosów 21"],
    ["jestem na Kobierzyńskiej", "Komandosów 21"],
    ["jestem przy Rondzie Grunwaldzkim", "Komandosów 21"],
    ["jestem na Prądniku Białym", "Prądnicka 77"],
    ["jestem na Opolskiej", "Prądnicka 77"],
    ["jestem koło Parku Lotników", "Dywizjonu 303 31E"],
  ];

  for (const [phrase, expectedName] of DECLINED_CASES) {
    test(`"${phrase}" rozpoznaje odmienioną formę i wskazuje ${expectedName}`, () => {
      const { match } = findLocationMatchDeterministic(phrase);
      assert.equal(match?.name, expectedName, `"${phrase}" powinno wskazywać ${expectedName}`);
    });
  }

  // "Bohaterów Września" jest własnym adresem salonu Bohaterów Września 1E (alias, sprawdzany
  // PRZED landmarkami) — mimo że Kniaźnina 1 też leży blisko tej ulicy, celowo NIE dodano jej tam
  // jako landmarku (patrz komentarz w salon.js), więc bez wyraźnej wzmianki o Mistrzejowicach/
  // Kniaźninie bot ufa temu, że kto mówi wprost "Bohaterów Września", ma na myśli TEN salon.
  test("'Bohaterów Września' bez dodatkowego kontekstu wskazuje pewnie na Bohaterów Września 1E", () => {
    const { match, viaLandmark } = findLocationMatchDeterministic("jestem na Bohaterów Września");
    assert.equal(match?.name, "Bohaterów Września 1E");
    assert.equal(viaLandmark, false, "to trafienie przez alias (własny adres), nie przez landmark");
  });
});

// Bot nie może nie rozumieć tego, co sam przed chwilą powiedział — od Krzysztofa, 21.09.2026.
// Realny błąd: przy niejednoznacznej ulicy bot czytał listę opcji ("...albo Wrocławska pięć A"),
// klient powtarzał ją słowo w słowo, a bot znów nie umiał wybrać i pytał o to samo — pętla, z której
// rozmowa wychodziła dopiero po wyczerpaniu prób. Powód: speechName ("Wrocławska pięć A") nie
// istniał nigdzie w rozpoznawaniu, były tylko formy z cyfrą ("wroclawska 5a").
describe("Round-trip — bot rozumie własne podpowiedzi", () => {
  // Liczone z konfiguracji, więc nowy salon z nierozpoznawalnym speechName od razu wywali ten test.
  for (const location of salonConfig.locations) {
    test(`"${location.speechName}" (to, co bot sam wymawia) wskazuje z powrotem na ${location.name}`, () => {
      const { match } = findLocationMatchDeterministic(location.speechName);
      assert.equal(match?.name, location.name);
    });
  }

  // Druga połowa tej samej pętli: podpowiedzi przy niejednoznaczności (landmarkSummary) też są
  // czytane klientowi na głos, więc wymienione w nich punkty muszą wracać do TEGO salonu.
  const SUMMARY_ECHOES = [
    ["koło Serenady", "Kniaźnina 1"],
    ["koło Multikina", "Kniaźnina 1"],
    ["przy Tauron Arenie", "Dywizjonu 303 31E"],
    ["koło Błoń", "Urzędnicza 48"],
    ["koło Galerii Krakowskiej", "Wrocławska 5A"],
    ["przy Kapelance", "Komandosów 21"],
  ];

  for (const [phrase, expectedName] of SUMMARY_ECHOES) {
    test(`"${phrase}" — bot rozumie punkt, który sam podaje jako podpowiedź`, () => {
      const { match } = findLocationMatchDeterministic(phrase);
      assert.equal(match?.name, expectedName);
    });
  }

  // Ulica jest niejednoznaczna, ale numer już nie — i to nawet gdy nazwa ulicy padła w odmienionej
  // formie, więc nie złapał jej żaden alias. Bez tego bot pytał "który dokładnie?" o coś, co klient
  // właśnie powiedział.
  test("numer przy odmienionej nazwie ulicy rozstrzyga niejednoznaczność", () => {
    assert.equal(
      findLocationMatchDeterministic("jestem na Wrocławskiej sześćdziesiąt").match?.name,
      "Wrocławska 60"
    );
    assert.equal(
      findLocationMatchDeterministic("jestem na Wrocławskiej pięć A").match?.name,
      "Wrocławska 5A"
    );
  });
});

// Reguła dopasowania form fleksyjnych — od Krzysztofa, 21.09.2026. Zastąpiła ręczne dopisywanie
// odmian w salon.js (63 wpisy, które i tak nie pokrywały wszystkiego). Testujemy samą regułę, bo to
// ona decyduje, czy baza lokalizacji w ogóle działa — i czy nie zaczyna łapać przypadkowych słów.
describe("wordFormsMatch — odmiana tak, przypadkowe zbliżenia nie", () => {
  const SAME_WORD = [
    ["serenady", "serenada"],
    ["multikina", "multikino"],
    ["placu", "plac"],
    ["krakowskiego", "krakowski"],
    ["bienczyckim", "bienczycki"],
    ["blon", "blonia"],
    ["kapelance", "kapelanka"],
  ];

  for (const [spoken, config] of SAME_WORD) {
    test(`"${spoken}" to ta sama forma co "${config}"`, () => {
      assert.equal(wordFormsMatch(spoken, config), true);
    });
  }

  const DIFFERENT_WORD = [
    // Rdzeń rozjeżdża się w środku słowa, nie na końcu.
    ["arka", "arce"],
    ["lewa", "lea"],
    // Za krótkie, żeby cokolwiek luzować — inaczej spójnik "ale" zbliżyłby się do "Aleja"
    // (zmierzone 21.09.2026 przy progu 3 znaków).
    ["ale", "aleja"],
    // Różnica dłuższa niż końcówka fleksyjna.
    ["olszanica", "olsza"],
  ];

  for (const [spoken, config] of DIFFERENT_WORD) {
    test(`"${spoken}" to NIE jest forma "${config}"`, () => {
      assert.equal(wordFormsMatch(spoken, config), false);
    });
  }

  // ZNANE OGRANICZENIE, świadomie zaakceptowane: sama reguła długości nie odróżni "parking" od
  // "park" ("ing" wygląda jak końcówka fleksyjna). Broni nas przed tym nie reguła, tylko baza:
  // "park" nigdy nie stoi w salon.js samodzielnie, zawsze w parze ("Park Krakowski", "park wodny"),
  // a frazy wielowyrazowe wymagają WSZYSTKICH słów po kolei. Ten test pilnuje jednego i drugiego —
  // gdyby ktoś dodał kiedyś samodzielny landmark "Park", zacznie tu czerwienić.
  test("'parking' w wypowiedzi nie wskazuje żadnego salonu, mimo zbliżenia do słowa 'park'", () => {
    assert.equal(wordFormsMatch("parking", "park"), true, "sama reguła długości tego nie rozróżnia");

    const singleWordLandmarks = salonConfig.locations.flatMap((l) =>
      l.landmarks.filter((landmark) => tokenizeForMatch(landmark).length === 1)
    );
    assert.ok(
      !singleWordLandmarks.some((landmark) => tokenizeForMatch(landmark)[0] === "park"),
      "'park' nie może być samodzielnym landmarkiem — dopiero wtedy 'parking' zacząłby w niego trafiać"
    );

    const { match, candidates } = findLocationMatchDeterministic("czy macie tam jakiś parking");
    assert.equal(match, null);
    assert.equal(candidates.length, 0);
  });

  // Najważniejsze zabezpieczenie: luz na końcówkę NIE może przywrócić kolizji Prądnik/Prądnicka,
  // naprawionej 17.09.2026. Dlatego poziom aliasów porównuje dokładnie, a "Prądnik Czerwony" to
  // fraza dwuczłonowa — sama "Prądnicka" nigdy jej nie wypełni.
  test("odmiana nie przywraca kolizji Prądnik Czerwony / Prądnicka", () => {
    assert.equal(findLocationMatchDeterministic("na Prądnickiej").match?.name, "Prądnicka 77");
    assert.equal(findLocationMatchDeterministic("na Prądniku Czerwonym").match?.name, "Kniaźnina 1");
  });

  // Zdania bez żadnej lokalizacji nie mogą trafiać w nic — to jest realne ryzyko przy luzowaniu
  // dopasowania, więc pilnujemy go wprost.
  const NO_LOCATION = [
    "spóźnię się jakieś dziesięć minut bo stoję w korku",
    "chciałbym się umówić na strzyżenie i brodę w sobotę rano",
    "dzień dobry mam pytanie o cennik i godziny otwarcia",
    "ale nie wiem gdzie dokładnie to jest",
    "dzwonię w sprawie vouchera na prezent dla taty",
  ];

  for (const phrase of NO_LOCATION) {
    test(`"${phrase}" nie wskazuje żadnego salonu`, () => {
      const { match, candidates } = findLocationMatchDeterministic(phrase);
      assert.equal(match, null);
      assert.equal(candidates.length, 0);
    });
  }
});

// Twilio transkrybuje mówiony sufiks budynku ("pięć A") na cyfrę + osobną literę Z ODSTĘPEM ("5 a"),
// nie jako zwarte "5a" — zaobserwowane na żywej rozmowie 21.09.2026 (zgłoszenie Wiktorii): odpowiedź
// "5A" na pytanie o Wrocławską 5A zamieniła się w transkrypcji na "5 a" i bot jej nie rozpoznał, mimo
// że wcześniej poprawnie zawęził wybór do trzech salonów.
describe("tokenizeForMatch — sufiks budynku rozbity spacją przez Twilio", () => {
  const CASES = [
    ["5 a", ["5a"]],
    ["5a", ["5a"]],
    ["Wrocławska 5 a", ["wroclawska", "5a"]],
    // Cyfra bez litery po niej zostaje osobnym tokenem — nie ma czego sklejać.
    ["Wrocławska 60", ["wroclawska", "60"]],
    // Sama litera bez poprzedzającej cyfry też zostaje bez zmian.
    ["salon a", ["salon", "a"]],
  ];

  for (const [input, expected] of CASES) {
    test(`"${input}" -> ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(tokenizeForMatch(input), expected);
    });
  }

  test("'5 a' samo w sobie wskazuje pewnie Wrocławską 5A (globalnie unikalny alias)", () => {
    const { match, candidates } = findLocationMatchDeterministic("5 a");
    assert.equal(match?.name, "Wrocławska 5A");
    assert.equal(candidates.length, 0);
  });
});
