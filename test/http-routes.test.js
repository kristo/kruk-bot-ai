const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { startTestServer } = require("./helpers/app");
const { getCallbackRequests } = require("../src/services/callLog");

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

let callCounter = 0;
function nextCallSid() {
  callCounter += 1;
  return `TEST-CALL-${callCounter}`;
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
  const body = await res.text();
  return { status: res.status, body };
}

describe("POST /voice/incoming", () => {
  test("przedstawia bota i otwiera Gather do /voice/intent", async () => {
    const { status, body } = await postVoice("/voice/incoming", {});
    assert.equal(status, 200);
    assert.match(body, /automatyczny asystent Kruk Barbershop/);
    // Zapowiedź konsultanta usunięta 17.09.2026 (uwaga z testów na żywo) — prośba o człowieka
    // nadal jest rozpoznawana w dowolnym momencie rozmowy, tylko od 18.09.2026 już nie łączy na
    // żywo (patrz opis dalej: "fraza transferu NIE łączy na żywo").
    assert.doesNotMatch(body, /poprosić o konsultanta/i);
    assert.match(body, /action="[^"]*\/voice\/intent\?attempt=0"/);
  });

  test("NIE zapowiada nagrywania — bot nagrywa dźwięku nie prowadzi", async () => {
    // Decyzja Damiana i Wiktorii z 16.09.2026. Zapowiedź była też nieprawdziwa: nie ma tu
    // werbu <Record>, jest tylko rozpoznawanie mowy, więc żadne nagranie nie powstaje.
    const { body } = await postVoice("/voice/incoming", {});
    assert.doesNotMatch(body, /nagryw/i);
  });

  test("nigdzie w kodzie nie ma werbu Record — zapowiedź nagrywania byłaby nieprawdziwa", () => {
    // Komentarze odcinamy, bo same wspominają <Record> przy wyjaśnieniu, dlaczego go tu nie ma.
    const code = require("node:fs")
      .readFileSync(require.resolve("../src/routes/voice.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\.record\s*\(/i);
  });
});

describe("POST /voice/intent — ścieżki bez wywołań AI", () => {
  test("SPOZNIENIE (szybki regex) kieruje do /voice/collect-late", async () => {
    const { body } = await postVoice("/voice/intent?attempt=0", { SpeechResult: "Spóźnię się na wizytę" });
    assert.match(body, /action="[^"]*\/voice\/collect-late\?attempt=0"/);
  });

  test("odwołanie wizyty NIE ląduje w ofercie zapisu na nową wizytę", async () => {
    const { body } = await postVoice("/voice/intent?attempt=0", { SpeechResult: "Muszę zmienić termin wizyty" });
    assert.doesNotMatch(body, /link do rezerwacji przez Booksy/);
    assert.match(body, /ograniczenia systemu Booksy/);
  });

  test("'inna pilna sprawa' nie dostaje komunikatu o ograniczeniach Booksy", async () => {
    const { body } = await postVoice("/voice/intent?attempt=0", { SpeechResult: "mam inną pilną sprawę" });
    assert.match(body, /przekażę sprawę Wiktorii/i);
    assert.doesNotMatch(body, /ograniczenia systemu Booksy/i);
  });

  // Rezygnacja z przekierowania na żywo — od Krzysztofa, 18.09.2026: "musimy zrezygnować z tego
  // przekierowania do konsultanta. zawsze będziemy mówić że Wiktoria oddzwoni". Prośba o człowieka
  // nadal jest rozpoznawana, tylko już nigdy nie łączy na żywo (<Dial>) — zawsze ta sama obietnica.
  test("fraza transferu NIE łączy na żywo — zawsze obietnica oddzwonienia", async () => {
    const callSid = nextCallSid();
    const params = new URLSearchParams({
      From: "+48600000000",
      To: "+48123456789",
      CallSid: callSid,
      SpeechResult: "Chcę rozmawiać z konsultantem",
    });
    const res = await fetch(`${baseUrl}/voice/intent?attempt=0`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const body = await res.text();

    assert.doesNotMatch(body, /<Dial/);
    assert.doesNotMatch(body, /<Number>/);
    assert.match(body, /Wiktoria oddzwoni i doradzi Ci w tej sprawie najszybciej/);

    const entry = getCallbackRequests({ limit: 200 }).find((r) => r.call_sid === callSid);
    assert.ok(entry, "prośba o człowieka powinna trafić do rejestru /admin/callbacks");
    assert.equal(entry.category, "INNE");
  });

  test("fraza transferu działa w dowolnym momencie rozmowy, nie tylko na starcie", async () => {
    // Sprawdzamy jedną z pozostałych tras (/voice/faq), żeby upewnić się, że rozpoznawanie nie
    // jest przywiązane tylko do pierwszego pytania.
    const { body } = await postVoice("/voice/faq?turn=2", { SpeechResult: "połącz mnie z kimś" });
    assert.doesNotMatch(body, /<Dial/);
    assert.match(body, /Wiktoria oddzwoni i doradzi Ci w tej sprawie najszybciej/);
  });
});

describe("POST /voice/faq — odmowa dalszej pomocy", () => {
  test("'Nie' kończy rozmowę, NIE przekazuje sprawy do Wiktorii", async () => {
    const { body } = await postVoice("/voice/faq?turn=2", { SpeechResult: "Nie" });
    assert.doesNotMatch(body, /Przekażę to pytanie do Wiktorii/);
    assert.match(body, /uwagi do mojego działania/);
  });

  test("prawdziwa wypowiedź zaczynająca się od 'Nie' nie jest traktowana jako odmowa", async () => {
    // Celowo fraza, która i tak rozstrzyga się szybkim regexem (ZAPIS, słowo "umówić") —
    // gdyby trafiła do PYTANIE, odpowiedź FAQ i tak wymaga prawdziwego wywołania AI, co
    // uczyniłoby ten test wolny i sieciowo zależny bez potrzeby (sprawdzamy tu tylko, że
    // GENERAL_DECLINE_REGEX nie łapie fałszywie, nie samo generowanie odpowiedzi FAQ).
    const { body } = await postVoice("/voice/faq?turn=2", {
      SpeechResult: "Nie chcę już czekać, chcę się od razu umówić",
    });
    assert.doesNotMatch(body, /uwagi do mojego działania/);
    // Sprawdzamy trasę, a nie dokładne brzmienie — treść o Booksy zależy od tego, czy wysyłka
    // SMS-a z linkiem jest włączona (SEND_CLIENT_BOOKSY_SMS), patrz willSendBooksySms.
    assert.match(body, /action="[^"]*\/voice\/booking-followup/);
    assert.match(body, /Booksy/);
  });
});

// Najczęstsze pytania mają być obsłużone z konfiguracji, bez ani jednego wywołania OpenAI —
// ani na klasyfikację intencji, ani na samą odpowiedź. Mierzymy czas, bo to jedyny sposób,
// żeby wykryć, że ktoś przypadkiem przywrócił którąś ścieżkę przez AI (tam to setki ms).
describe("FAQ z konfiguracji — bez wywołań AI", () => {
  const INSTANT_QUESTIONS = [
    ["jakie macie godziny otwarcia", /8:00 do 20:00/],
    ["o której zamykacie w soboty", /8:00 do 16:00/], // słowa spoza FAQ_KEYWORDS_REGEX
    ["ile kosztuje strzyżenie", /90 złotych/],
    ["czy macie vouchery na prezent", /voucher/i],
  ];

  for (const [question, expected] of INSTANT_QUESTIONS) {
    test(`"${question}" odpowiada natychmiast`, async () => {
      const startedAt = Date.now();
      const { body } = await postVoice("/voice/intent?attempt=0", { SpeechResult: question });
      const elapsed = Date.now() - startedAt;

      assert.match(body, expected);
      assert.ok(
        elapsed < 300,
        `odpowiedź zajęła ${elapsed} ms — to wygląda na wywołanie AI, które miało zostać pominięte`
      );
    });
  }
});

// Po wysłaniu linku Booksy bot pyta, czy klient mimo to chce telefonu. Wcześniej KAŻDA
// wypowiedź była tu rozumiana jako "tak, zadzwońcie" — łącznie z odmową. Diagram Damiana
// i Wiktorii (16.09.2026) mówi wprost: "powiedz teraz TAK, a Wiktoria oddzwoni".
describe("Po linku Booksy — TAK zgłasza od razu, bez pytania o lokalizację", () => {
  for (const answer of ["Nie, dziękuję, wiem jak korzystać", "Nie trzeba", "Nie"]) {
    test(`"${answer}" kończy rozmowę, bez zgłoszenia`, async () => {
      const { body } = await postVoice("/voice/booking-followup?attempt=0", { SpeechResult: answer });
      assert.doesNotMatch(body, /Wiktoria oddzwoni/);
      assert.match(body, /uwagi do mojego działania/);
    });
  }

  // Od Damiana, 18.09.2026: "może bot nie dopytywać o lokalizację?" — skoro Wiktoria i tak
  // oddzwania, sama dopyta o salon podczas rozmowy. Bot już NIE pyta o adres w tym miejscu
  // (dawniej: BOOKING_PROMPT -> /voice/collect-booking, usunięte razem z całą tą ścieżką).
  for (const answer of ["Tak", "Tak, poproszę o telefon", "tak, nie umiem tego zrobić"]) {
    test(`"${answer}" zgłasza od razu, bez pytania o adres salonu`, async () => {
      const { body } = await postVoice("/voice/booking-followup?attempt=0", { SpeechResult: answer });
      assert.doesNotMatch(body, /adres salonu/);
      assert.doesNotMatch(body, /action="[^"]*\/voice\/collect-booking/);
      assert.match(body, /Wiktoria oddzwoni/);
    });
  }

  test("lokalizacja rozpoznana z pierwszej wypowiedzi trafia do zgłoszenia bez ponownego pytania", async () => {
    const callSid = nextCallSid();
    const params = new URLSearchParams({
      From: "+48600000000",
      To: "+48123456789",
      CallSid: callSid,
      SpeechResult: "Tak",
    });
    const res = await fetch(
      `${baseUrl}/voice/booking-followup?attempt=0&location=${encodeURIComponent("Urzędnicza 48")}`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() }
    );
    const body = await res.text();
    assert.match(body, /Wiktoria oddzwoni/);
    assert.doesNotMatch(body, /adres salonu/);

    const entry = getCallbackRequests({ limit: 200 }).find((r) => r.call_sid === callSid);
    assert.ok(entry, "zgłoszenie powinno trafić do rejestru /admin/callbacks");
    assert.match(entry.summary, /Urzędnicza 48/);
  });

  test("brak wcześniej rozpoznanej lokalizacji nie wymyśla żadnego salonu w zgłoszeniu", async () => {
    const callSid = nextCallSid();
    const params = new URLSearchParams({ From: "+48600000000", To: "+48123456789", CallSid: callSid, SpeechResult: "Tak" });
    await fetch(`${baseUrl}/voice/booking-followup?attempt=0`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const entry = getCallbackRequests({ limit: 200 }).find((r) => r.call_sid === callSid);
    assert.ok(entry);
    assert.match(entry.summary, /Salon: nie podano/);
  });
});

describe("Ścieżka ZAPIS — obietnica SMS-a tylko gdy SMS faktycznie leci", () => {
  // Lokalne .env ma SEND_CLIENT_BOOKSY_SMS=false, więc bot NIE może mówić, że wysyła SMS-a.
  // Celowo nie testujemy tu wariantu z włączoną flagą — wysłałby prawdziwego SMS-a przez Twilio.
  test("przy wyłączonej wysyłce bot kieruje do aplikacji Booksy zamiast obiecywać SMS", async () => {
    assert.notEqual(process.env.SEND_CLIENT_BOOKSY_SMS, "true", "test zakłada wyłączoną wysyłkę");

    const { body } = await postVoice("/voice/intent?attempt=0", {
      SpeechResult: "chciałbym się umówić na strzyżenie",
    });
    assert.doesNotMatch(body, /Wysyłam Ci SMS-em/);
    assert.match(body, /aplikację Booksy/);
  });
});

// Błąd znaleziony w przeglądzie 15.09.2026: gołe "Nie" (tak zwraca rozpoznawanie mowy — bez
// kropki) przechodziło jako POTWIERDZENIE, więc bot robił dokładnie odwrotnie, niż prosił klient.
// Testujemy przez HTTP, nie tylko na regexie, żeby wyłapać też pomyłkę w samej trasie.
describe("Pytania zamknięte — 'Nie' musi znaczyć nie", () => {
  test("/voice/confirm-other: 'Nie' NIE wysyła zgłoszenia do Wiktorii", async () => {
    const { body } = await postVoice("/voice/confirm-other?speech=reklamacja%20us%C5%82ugi", {
      SpeechResult: "Nie",
    });
    assert.match(body, /nie przekazuję/i);
    assert.doesNotMatch(body, /Wiktoria oddzwoni/);
  });

  test("/voice/confirm-other: 'Tak' nadal wysyła zgłoszenie", async () => {
    const { body } = await postVoice("/voice/confirm-other?speech=reklamacja%20us%C5%82ugi", {
      SpeechResult: "Tak",
    });
    assert.match(body, /Wiktoria oddzwoni/);
  });

  test("/voice/confirm-other: 'Tak, bo nie mogę się dodzwonić' to nadal zgoda", async () => {
    const { body } = await postVoice("/voice/confirm-other?speech=reklamacja%20us%C5%82ugi", {
      SpeechResult: "Tak, bo nie mogę się dodzwonić",
    });
    assert.match(body, /Wiktoria oddzwoni/);
  });

  test("/voice/collect-late-confirm: 'Nie' pyta o adres, nie zgłasza spóźnienia do złego salonu", async () => {
    const { body } = await postVoice(
      "/voice/collect-late-confirm?location=Urz%C4%99dnicza%2048&speech=ko%C5%82o%20rynku",
      { SpeechResult: "Nie" }
    );
    assert.match(body, /dokładną nazwę ulicy/);
    assert.doesNotMatch(body, /przekazuję informację o spóźnieniu/);
  });

  test("/voice/collect-late-confirm: cisza nadal potwierdza (lepiej zgłosić niż zgubić)", async () => {
    const { body } = await postVoice(
      "/voice/collect-late-confirm?location=Urz%C4%99dnicza%2048&speech=ko%C5%82o%20rynku",
      { SpeechResult: "" }
    );
    assert.match(body, /przekazuję informację o spóźnieniu/);
  });
});

describe("POST /voice/feedback — krótkie potwierdzenie bez treści", () => {
  test("'Tak, mam uwagi' dopytuje o treść zamiast połknąć to jako całą uwagę", async () => {
    const { body } = await postVoice("/voice/feedback", { SpeechResult: "Tak, mam uwagi" });
    assert.match(body, /Słucham, jakie to uwagi/);
    assert.match(body, /action="[^"]*\/voice\/feedback\?attempt=1"/);
  });

  test("dłuższa, treściwa uwaga zaczynająca się od 'Tak' nie wywołuje dopytania", async () => {
    const { body } = await postVoice("/voice/feedback", {
      SpeechResult: "Tak, uważam że bot mówi zdecydowanie za szybko",
    });
    assert.doesNotMatch(body, /Słucham, jakie to uwagi/);
  });
});

describe("POST /voice/feedback — odmowa zostawienia uwagi", () => {
  // Zaobserwowane na żywej rozmowie pierwszego dnia produkcji (22.09.2026): "Nie, dziękuję" w
  // odpowiedzi na zachętę "jeśli masz jakieś uwagi... powiedz je teraz" trafiało do zespołu jako
  // [UWAGA O BOCIE], razem z fałszywym potwierdzeniem "przekazuję Twoją uwagę dalej".
  test("'Nie, dziękuję' kończy rozmowę bez fałszywej uwagi ani zgłoszenia", async () => {
    const { body } = await postVoice("/voice/feedback", { SpeechResult: "Nie, dziękuję." });
    assert.doesNotMatch(body, /przekazuję Twoją uwagę dalej/);
    assert.doesNotMatch(body, /Słucham, jakie to uwagi/);
  });

  test("samo 'Nie' też kończy rozmowę bez zgłoszenia", async () => {
    const { body } = await postVoice("/voice/feedback", { SpeechResult: "Nie." });
    assert.doesNotMatch(body, /przekazuję Twoją uwagę dalej/);
  });

  test("realna uwaga zaczynająca się od 'Nie' nadal trafia do zespołu", async () => {
    const { body } = await postVoice("/voice/feedback", {
      SpeechResult: "Nie zrozumiałeś mnie za pierwszym razem, musiałem powtarzać.",
    });
    assert.match(body, /przekazuję Twoją uwagę dalej/);
  });
});

// Na produkcji (15.09.2026) POST bez treści wywracał weryfikację podpisu Twilio wyjątkiem
// (Object.keys(undefined) w SDK), więc zamiast 403 wracał TwiML ze statusem 200. Tu wymuszamy
// prawdziwą weryfikację — bez NODE_ENV=development, które ją w testach omija.
describe("Weryfikacja podpisu Twilio — żądania niepoprawne", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  after(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test("POST bez treści i bez podpisu dostaje czyste 403, nie wyjątek", async () => {
    process.env.NODE_ENV = "production";
    const res = await fetch(`${baseUrl}/voice/incoming`, { method: "POST" });
    assert.equal(res.status, 403);
  });

  test("POST z treścią, ale bez podpisu, też dostaje 403", async () => {
    process.env.NODE_ENV = "production";
    const res = await fetch(`${baseUrl}/voice/incoming`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=X&From=%2B48600000000",
    });
    assert.equal(res.status, 403);
  });
});

// Ścieżka spóźnienia wg ustaleń z Wiktorią (16.09.2026): kto od razu poda salon, ma mieć
// zgłoszenie bez ani jednego dodatkowego pytania ("żeby też sztucznie nie wydłużać rozmowy");
// kto nie wie, dostaje zawężanie obszarami zamiast "powiedz jeszcze raz adres".
describe("Spóźnienie — zawężanie obszarem, ale bez zbędnych pytań", () => {
  test("podanie salonu wprost zgłasza od razu, bez dopytywania", async () => {
    const { body } = await postVoice("/voice/collect-late?attempt=0", {
      SpeechResult: "spóźnię się na Dywizjonu",
    });
    assert.match(body, /Zrozumiałem, że chodzi o salon Dywizjonu trzysta trzy trzydzieści jeden E/);
    assert.match(body, /action="[^"]*\/voice\/collect-late-confirm\?/);
    assert.doesNotMatch(body, /Jesteś umówiony w Nowej Hucie/);
  });

  test("brak rozpoznania pyta o obszar zamiast powtarzać prośbę o adres", async () => {
    const { body } = await postVoice("/voice/collect-late?attempt=0", {
      SpeechResult: "nie wiem, gdzieś w Krakowie",
    });
    assert.match(body, /Jesteś umówiony w Nowej Hucie, na Krowodrzy, w centrum, na Dębnikach czy na Prądniku Czerwonym/);
    assert.doesNotMatch(body, /powiedz jeszcze raz adres/);
  });

  test("'w centrum' wymienia salony do wyboru, nie jest ślepym zaułkiem", async () => {
    const { body } = await postVoice("/voice/collect-late?attempt=0", { SpeechResult: "w centrum" });
    assert.match(body, /Mamy tam kilka salonów/);
    assert.match(body, /Urzędnicza czterdzieści osiem/);
  });

  test("podanie dzielnicy z jednym salonem zgłasza od razu", async () => {
    const { body } = await postVoice("/voice/collect-late?attempt=0", { SpeechResult: "na Dębnikach" });
    assert.match(body, /Zrozumiałem, że chodzi o salon Komandosów dwadzieścia jeden/);
    assert.match(body, /action="[^"]*\/voice\/collect-late-confirm\?/);
  });

  test("druga nieudana próba nie powtarza długiego pytania o obszar", async () => {
    const { body } = await postVoice("/voice/collect-late?attempt=1", { SpeechResult: "nie mam pojęcia" });
    assert.match(body, /nazwę ulicy albo dzielnicy/);
    assert.doesNotMatch(body, /Jesteś umówiony w Nowej Hucie/);
  });

  test("po wyczerpaniu prób bez lokalizacji bot nie udaje, że rozpoznał salon", async () => {
    const { body } = await postVoice("/voice/collect-late?attempt=2", { SpeechResult: "" });
    assert.match(body, /Nie udało mi się ustalić, do którego salonu jesteś umówiony/i);
    assert.doesNotMatch(body, /przekazuję informację o spóźnieniu do salonu/i);
  });

  // Od Wiktorii, 21.09.2026: "brzmi jak call center". Sprawdzamy tylko treść <Say> (to, co bot
  // faktycznie wymawia) — atrybut hints w <Gather> dalej zawiera "konsultant" celowo, żeby rozpoznać,
  // gdy TO KLIENT użyje tego słowa (patrz SPEECH_HINT_TERMS/TRANSFER_KEYWORDS_REGEX), to nie jest to,
  // co się tu sprawdza.
  test("bot już nie mówi 'konsultant'", async () => {
    const { body } = await postVoice("/voice/collect-late?attempt=2", { SpeechResult: "" });
    const spoken = (body.match(/<Say[^>]*>(.*?)<\/Say>/gs) || []).join(" ");
    assert.doesNotMatch(spoken, /konsultant/i);
    assert.match(spoken, /przekazuję sprawę dalej/i);
  });
});

// Realny przebieg z produkcji, 21.09.2026 (zgłoszenie Wiktorii przez WhatsApp): bot poprawnie
// zawęził "Wrocławska" do trzech kandydatów, ale gdy odpowiedziała samym "5A", Twilio przetranskrybowało
// to jako "5 a" (dwa tokeny) i bot tego nie złapał — wyczerpał próby, zanim w ogóle usłyszał odpowiedź.
// Naprawa ma dwie części: (1) sklejanie "cyfra + spacja + litera" z powrotem w jeden token
// (tokenizeForMatch), (2) przenoszenie listy kandydatów między turami, żeby sam numer/litera —
// bez powtarzania nazwy ulicy — dało się dopasować TYLKO wśród tego, co bot przed chwilą wymienił.
describe("Spóźnienie — klient odpowiada samym numerem na pytanie bota (21.09.2026)", () => {
  test("replay zgłoszenia Wiktorii: Wrocławska -> trzej kandydaci -> '5 a' -> potwierdzenie Wrocławskiej 5A", async () => {
    const callSid = nextCallSid();
    const fields = { From: "+48600000000", To: "+48123456789", CallSid: callSid };

    const first = await postVoice("/voice/collect-late?attempt=0", { ...fields, SpeechResult: "Wrocławska" });
    assert.match(first.body, /Mamy tam kilka salonów/);
    assert.match(first.body, /Wrocławska pięć A/);
    const actionMatch = first.body.match(/action="([^"]*)"/);
    assert.ok(actionMatch, "odpowiedź z kandydatami musi zawierać Gather z action");
    const nextPath = actionMatch[1].replace(/&amp;/g, "&").replace(process.env.BASE_URL, "");

    const second = await postVoice(nextPath, { ...fields, SpeechResult: "5 a" });
    assert.match(second.body, /Zrozumiałem, że chodzi o salon Wrocławska pięć A\. Czy potwierdzasz/);
  });

  test("salon bez własnego aliasu liczbowego (Urzędnicza 48) też daje się zawęzić samym numerem", async () => {
    const callSid = nextCallSid();
    const fields = { From: "+48600000000", To: "+48123456789", CallSid: callSid };

    const first = await postVoice("/voice/collect-late?attempt=0", { ...fields, SpeechResult: "jestem w centrum" });
    assert.match(first.body, /Mamy tam kilka salonów/);
    assert.match(first.body, /Urzędnicza czterdzieści osiem/);
    const actionMatch = first.body.match(/action="([^"]*)"/);
    const nextPath = actionMatch[1].replace(/&amp;/g, "&").replace(process.env.BASE_URL, "");

    const second = await postVoice(nextPath, { ...fields, SpeechResult: "czterdzieści osiem" });
    assert.match(second.body, /Zrozumiałem, że chodzi o salon Urzędnicza czterdzieści osiem\. Czy potwierdzasz/);
  });

  test("odpowiedź spoza listy kandydatów NIE wymusza żadnego z nich — bot dalej pyta/zawęża normalnie", async () => {
    const callSid = nextCallSid();
    const fields = { From: "+48600000000", To: "+48123456789", CallSid: callSid };

    const first = await postVoice("/voice/collect-late?attempt=0", { ...fields, SpeechResult: "Wrocławska" });
    const actionMatch = first.body.match(/action="([^"]*)"/);
    const nextPath = actionMatch[1].replace(/&amp;/g, "&").replace(process.env.BASE_URL, "");

    // Klient zmienia zdanie i podaje zupełnie inny, jednoznaczny salon — to ma wygrać, a nie
    // wymuszone dopasowanie do jednego z trzech wcześniej wymienionych kandydatów.
    const second = await postVoice(nextPath, { ...fields, SpeechResult: "Komandosów" });
    assert.match(second.body, /Zrozumiałem, że chodzi o salon Komandosów dwadzieścia jeden\. Czy potwierdzasz/);
  });
});

describe("Po odpowiedzi FAQ — pytanie o satysfakcję (ustalenia z 16.09.2026)", () => {
  test("zadowolony klient nie generuje Wiktorii zgłoszenia", async () => {
    const { body } = await postVoice("/voice/faq?turn=3", { SpeechResult: "Tak, dziękuję" });
    assert.doesNotMatch(body, /przekażę sprawę Wiktorii/);
  });

  test("niezadowolony klient dostaje obietnicę oddzwonienia", async () => {
    const { body } = await postVoice("/voice/faq?turn=3", { SpeechResult: "Nie, to mi nie wystarczy" });
    assert.match(body, /przekażę sprawę Wiktorii/);
  });

  test("pytanie brzmi jednoznacznie — jedno pytanie zamknięte, nie trzy naraz", async () => {
    const { body } = await postVoice("/voice/intent?attempt=0", { SpeechResult: "ile kosztuje strzyżenie" });
    assert.match(body, /Czy to wyczerpująca odpowiedź/);
    assert.doesNotMatch(body, /albo wolisz, żeby Wiktoria oddzwoniła/);
  });
});

// Nowa ścieżka WSPOLPRACA — od Wiktorii/Damiana, 17.09.2026. Kluczowe: bot NIE obiecuje
// oddzwonienia (Wiktoria: "żebym wiedziała że nie muszę oddzwaniać"), tylko dopytuje w skrócie
// i przekazuje dalej.
describe("Telefon o współpracy — bez obietnicy oddzwonienia", () => {
  test("rozpoznanie 'współpraca' pyta w skrócie, o co chodzi", async () => {
    const { body } = await postVoice("/voice/intent?attempt=0", {
      SpeechResult: "Dzień dobry, dzwonię w sprawie współpracy",
    });
    assert.match(body, /czego miałaby dotyczyć ta współpraca/i);
    assert.match(body, /action="[^"]*\/voice\/collect-cooperation/);
  });

  test("po podaniu szczegółów bot NIE obiecuje, że Wiktoria oddzwoni", async () => {
    const { body } = await postVoice("/voice/collect-cooperation?attempt=0", {
      SpeechResult: "Oferujemy kosmetyki do stylizacji brody hurtowo",
    });
    assert.doesNotMatch(body, /Wiktoria oddzwoni/i);
    assert.doesNotMatch(body, /oddzwoni i doradzi/i);
    assert.match(body, /przekazuję tę informację do zespołu/i);
  });

  test("cisza dopytuje, a po wyczerpaniu prób kończy rozmowę bez zgłoszenia", async () => {
    const { body } = await postVoice("/voice/collect-cooperation?attempt=2", { SpeechResult: "" });
    assert.match(body, /Nie udało się zebrać szczegółów współpracy/i);
  });

  test("prawdziwy klient pytający o ofertę usług nie trafia w tę ścieżkę", async () => {
    const { body } = await postVoice("/voice/intent?attempt=0", { SpeechResult: "jaka jest wasza oferta na brodę" });
    assert.doesNotMatch(body, /czego miałaby dotyczyć ta współpraca/i);
  });
});

// Wzbogacenie potwierdzenia w ścieżce "inna sprawa" o wykryty salon — od Damiana, 17.09.2026:
// "może bot jeszcze powtórzyć czy dobrze wyłapał salon... żeby jeśli ktoś się pomyli, mógł się
// poprawić". Dotyczy głównie odwołań wizyt, gdzie klient zwykle sam podaje adres w opisie.
describe("'Inna sprawa' — potwierdzenie wykrytego salonu, jeśli klient go podał", () => {
  test("jednoznacznie wykryty salon jest powtórzony w pytaniu o potwierdzenie", async () => {
    const { body } = await postVoice("/voice/collect-other?attempt=0", {
      SpeechResult: "Chcę odwołać wizytę na Dywizjonu jutro o 15",
    });
    assert.match(body, /Zrozumiałem, że chodzi o salon Dywizjonu trzysta trzy trzydzieści jeden E/);
    assert.match(body, /Czy mam przekazać to zgłoszenie Wiktorii, żeby oddzwoniła/);
  });

  test("brak jednoznacznego salonu w opisie nie wymyśla żadnego", async () => {
    const { body } = await postVoice("/voice/collect-other?attempt=0", {
      SpeechResult: "Chcę zgłosić uwagę do obsługi",
    });
    assert.doesNotMatch(body, /Zrozumiałem, że chodzi o salon/);
    assert.match(body, /Czy mam przekazać to zgłoszenie Wiktorii, żeby oddzwoniła/);
  });

  test("cała treść zgłoszenia (z adresem) i tak trafia do Wiktorii niezależnie od wykrycia", async () => {
    const { body } = await postVoice("/voice/confirm-other?speech=Odwo%C5%82anie%20na%20Urz%C4%99dniczej", {
      SpeechResult: "Tak",
    });
    assert.match(body, /Wiktoria oddzwoni/);
  });
});

// Fallback AI dla nieznanych landmarków (salon.js nie ma wszystkich) — od Krzysztofa, 18.09.2026.
// Test na żywym AI: nie zakładamy, że model trafnie zgadnie KTÓRY salon (kwestia jego wiedzy
// geograficznej, nie coś, co ten pakiet testów arbitrażuje) — sprawdzamy tylko, że wynik jest
// ZAWSZE bezpieczny: albo prawdziwe potwierdzenie salonu z naszej listy, albo uczciwe przyznanie
// "nie złapałem" / zawężanie obszarem. Nigdy crash, nigdy cichy, niepotwierdzony strzał.
describe("Spóźnienie — fallback AI dla nieznanego landmarku", () => {
  test("prawdziwy landmark spoza salon.js kończy się bezpiecznie: potwierdzeniem znanego salonu albo uczciwym 'nie złapałem'", async () => {
    const { body } = await postVoice("/voice/collect-late?attempt=0", {
      SpeechResult: "jestem umówiony gdzieś koło Cracovii, tego stadionu przy Błoniach",
    });

    const proposesKnownSalon = /Zrozumiałem, że chodzi o salon (Wrocławska sześćdziesiąt|Urzędnicza czterdzieści osiem|Dywizjonu trzysta trzy trzydzieści jeden E|Kniaźnina jeden|Komandosów dwadzieścia jeden|Bohaterów Września jeden E|Prądnicka siedemdziesiąt siedem|Wrocławska pięć A|Niepodległości trzy A)\./.test(
      body
    );
    const admitsUncertainty = /nie złapałem|Jesteś umówiony w Nowej Hucie/i.test(body);

    assert.ok(
      proposesKnownSalon || admitsUncertainty,
      `odpowiedź musi albo potwierdzić realny salon, albo uczciwie przyznać niepewność — dostano: ${body.slice(0, 300)}`
    );
  });
});
