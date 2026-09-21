const OpenAI = require("openai");
const salonConfig = require("../config/salon");

const REQUEST_TIMEOUT_MS = 7000; // rozmowa telefoniczna nie może czekać w nieskończoność na odpowiedź OpenAI

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: REQUEST_TIMEOUT_MS });
  return _openai;
}

/**
 * Buduje kontekst systemowy na podstawie konfiguracji salonu.
 * OpenAI dostaje pełną wiedzę o salonie — nie hallucynuje danych.
 */
function buildSystemPrompt() {
  const branchCount = salonConfig.declaredBranchCount || (salonConfig.locations || []).length;

  const hours = Object.entries(salonConfig.hours)
    .map(([day, h]) => `  ${day}: ${h}`)
    .join("\n");

  const services = salonConfig.services
    .map((s) => `  - ${s.name}: ${s.price}, czas ~${s.duration}`)
    .join("\n");

  const locations = salonConfig.locations
    .map((l) => {
      const landmarks = l.landmarkSummary ? ` | Okolica: ${l.landmarkSummary}` : "";
      return `  - ${l.name} (${l.district}) | Parking: ${l.parking}${landmarks}`;
    })
    .join("\n");

  return `Jesteś pomocnym asystentem telefonicznym sieci salonów barberskich "${salonConfig.name}" w Krakowie.
Odpowiadasz WYŁĄCZNIE na pytania dotyczące tych salonów. Mów po polsku, krótko i naturalnie — to rozmowa telefoniczna.
Nie wymieniaj długich list punktowanych, mów płynnymi zdaniami. Maksymalnie 2-3 zdania na odpowiedź.
Odpowiedzi mają brzmieć różnorodnie i naturalnie. Nie zaczynaj ciągle od tych samych fraz, unikaj powtarzania identycznych końcówek i nie nadużywaj formuły "Oczywiście".
Jeśli to możliwe, dawaj odpowiedź konkretną, ale bez sztywnego stylu FAQ.
Jeśli klient pyta o konkretną dzielnicę lub lokalizację, podaj odpowiedni salon.

== DANE SIECI ==
Nazwa: ${salonConfig.name}
Miasto: ${salonConfig.city}
Telefon: ${salonConfig.phone}
Email: ${salonConfig.email}
Ocena: ${salonConfig.rating}

Godziny otwarcia (wszystkie lokalizacje):
${hours}

Lokalizacje (${branchCount} salonów w Krakowie):
${locations}

Usługi i cennik:
${services}

O nas: ${salonConfig.about.staff}
Kosmetyki: ${salonConfig.about.products}
Atmosfera: ${salonConfig.about.atmosphere}
Techniki: ${salonConfig.about.techniques}

Vouchery/bony podarunkowe: ${salonConfig.vouchers.info}

Rezerwacje: ${salonConfig.booking.info}

== ZASADY ==
- Jeśli pytanie nie dotyczy salonów, powiedz grzecznie że nie możesz pomóc w tej kwestii.
- Jeśli nie znasz odpowiedzi, poleć kontakt: ${salonConfig.phone} lub ${salonConfig.email}.
- Nie podawaj informacji spoza powyższych danych.
- Przy pytaniu o rezerwację zawsze kieruj na Booksy lub telefon ${salonConfig.booking.phone}.
- W rozmowie telefonicznej nie czytaj długich URL. Zamiast tego powiedz, że link do rezerwacji wyślemy SMS-em.
- Numer telefonu czytaj wolno, grupami cyfr (np. "plus 48, 6 6 6, 2 4 1, 4 4 2"), nigdy jako jedną liczbę.`;
}

/**
 * @param {string} userSpeech - transkrybowana wypowiedź klienta
 * @returns {Promise<string>} - odpowiedź do przeczytania przez TTS
 */
async function getAIResponse(userSpeech) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const completion = await getOpenAI().chat.completions.create({
    model,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user",   content: userSpeech },
    ],
    max_tokens: 160,
    temperature: 0.65,
    presence_penalty: 0.35,
    frequency_penalty: 0.45,
  });

  return completion.choices[0].message.content.trim();
}

const INTENT_LABELS = ["ZAPIS", "SPOZNIENIE", "PYTANIE", "INNE"];

const INTENT_CLASSIFIER_PROMPT = `Klasyfikujesz intencję rozmówcy dzwoniącego do salonu barberskiego.
Rozmówcy często mówią nieskładnie, zaczynają od przeprosin albo tłumaczenia się, zanim dotrą do sedna,
i rzadko używają wprost słowa "spóźnię się" — opisują za to objawy spóźnienia (korek, coś wypadło,
"nie zdążę na czas", "jestem w drodze ale..."). Analizuj sens całej wypowiedzi, nie pojedyncze słowa.

Wybierz DOKŁADNIE JEDNĄ etykietę:
- ZAPIS — chce się umówić/zarezerwować NOWĄ wizytę (jeszcze jej nie ma)
- SPOZNIENIE — ma już umówioną wizytę i sygnalizuje, że dotrze później albo może nie zdążyć na czas —
  NIEZALEŻNIE od tego, czy używa słowa "spóźnię się", czy opisuje to inaczej (korek, coś wypadło,
  awaria, "nie zdążę", "będę później")
- PYTANIE — pyta o godziny, cennik, adres, usługi, parking, opinie itp.
- INNE — coś innego: reklamacja, ODWOŁANIE lub ZMIANA już istniejącej wizyty (to NIE jest ZAPIS —
  klient nie chce umówić nowej wizyty, tylko zmienić/anulować już istniejącą), inna sprawa, albo
  naprawdę niejasne

Przykłady (tylko dla kalibracji, nie dosłowne dopasowania):
"utknąłem w korku, nie zdążę na czas" -> SPOZNIENIE
"coś mi wypadło, jadę ale będę później" -> SPOZNIENIE
"auto mi się popsuło, dojadę z opóźnieniem" -> SPOZNIENIE
"chciałbym się umówić na jutro" -> ZAPIS
"czy jest wolny termin w tym tygodniu" -> ZAPIS
"chcę odwołać wizytę" -> INNE
"muszę przełożyć termin na inny dzień" -> INNE

Odpowiedz WYŁĄCZNIE jednym słowem, bez interpunkcji: ZAPIS, SPOZNIENIE, PYTANIE albo INNE.`;

/**
 * Fallback klasyfikacji intencji przez AI — używany tylko wtedy, gdy szybkie dopasowanie
 * słów kluczowych (detectIntent w voice.js) nic nie złapało. Rozmówcy potrafią mówić
 * nieskładnie, od tyłu albo się tłumaczyć, więc regex sam w sobie czasem nie wystarcza.
 * @param {string} userSpeech - transkrybowana wypowiedź klienta
 * @returns {Promise<string>} - jedna z etykiet: ZAPIS, SPOZNIENIE, PYTANIE, INNE
 */
async function classifyIntent(userSpeech) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const completion = await getOpenAI().chat.completions.create({
    model,
    messages: [
      { role: "system", content: INTENT_CLASSIFIER_PROMPT },
      { role: "user", content: userSpeech },
    ],
    // Uwaga: 5 tokenów ucinało odpowiedź w połowie słowa (np. "SPOZNIEN") i model
    // milcząco lądował w fallbacku "INNE" poniżej — zaobserwowane na testach 05.09.2026.
    max_tokens: 20,
    temperature: 0,
  });

  const label = (completion.choices[0].message.content || "").trim().toUpperCase();
  return INTENT_LABELS.includes(label) ? label : "INNE";
}

const LOCATION_EXTRACTION_PROMPT = `Klient dzwoni do sieci salonów barberskich i próbuje podać adres, ulicę albo dzielnicę
salonu, ale miesza to z innymi rzeczami — narzeka, dygresuje, rozmawia przez chwilę z kimś obok,
dodaje zbędne słowa. Twoje jedyne zadanie: wyłuskaj z całej wypowiedzi TYLKO fragment dotyczący
adresu/ulicy/dzielnicy, bez reszty zdania. NIE zgaduj i NIE uzupełniaj niczego od siebie — jeśli
w wypowiedzi nie ma żadnej wzmianki o miejscu, odpowiedz dokładnie: BRAK

Przykłady:
"eee, no więc, chodzi mi o... czekaj, no dobra, Nowa Huta chyba" -> Nowa Huta
"a weź, momencik - [do kogoś obok: zaraz wracam] - to na Krowodrzy było, tak" -> Krowodrza
"nie no w sumie to ja nie wiem, chciałbym się tylko umówić" -> BRAK

Odpowiedz WYŁĄCZNIE wyłuskanym fragmentem (bez cudzysłowów, bez komentarza) albo słowem BRAK.`;

/**
 * Fallback ekstrakcji lokalizacji z zaszumionej wypowiedzi — używany tylko wtedy, gdy
 * deterministyczny matcher (findLocationMatchDeterministic w voice.js) nic nie znalazł.
 * Celowo NIE zgaduje salonu sam — tylko oczyszcza wypowiedź z dygresji/narzekania/rozmowy
 * z kimś obok, a wynik i tak wraca przez ten sam zaufany deterministyczny matcher. To unika
 * wcześniej zaobserwowanego halucynowania pierwszego salonu z listy przy braku sygnału
 * (patrz komentarz przy findLocationMatch) — tu AI nie wybiera salonu, tylko fragment tekstu.
 * Zgłoszone przez Wiktorię/Damiana, 08.09.2026: bot zbyt łatwo się poddawał przy dodatkowych
 * słowach w wypowiedzi ("walecznego zawodnika" zamiast kogoś, kto się szybko poddaje).
 * @param {string} userSpeech - transkrybowana wypowiedź klienta
 * @returns {Promise<string|null>} - wyłuskany fragment o lokalizacji, albo null gdy brak
 */
async function extractLocationPhrase(userSpeech) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const completion = await getOpenAI().chat.completions.create({
    model,
    messages: [
      { role: "system", content: LOCATION_EXTRACTION_PROMPT },
      { role: "user", content: userSpeech },
    ],
    max_tokens: 30,
    temperature: 0,
  });

  const text = (completion.choices[0].message.content || "").trim();
  if (!text || text.toUpperCase() === "BRAK") return null;
  return text;
}

/**
 * Fallback dla PRAWDZIWYCH punktów orientacyjnych, których po prostu nie ma w ręcznie
 * prowadzonej liście w salon.js (np. "Rondo Grzegórzeckie", o którym nikt wcześniej nie
 * pomyślał) — od Krzysztofa, 18.09.2026: "bot często nie zna punktów orientacyjnych Krakowa".
 *
 * UWAGA — to NIE jest ten sam pomysł, co odrzucony wcześniej "AI wybiera salon samo" (patrz
 * komentarz przy findLocationMatch w voice.js: obserwowane trzykrotnie na żywo, że model
 * zgadywał pierwszy salon z listy, gdy wypowiedź w ogóle NIE dawała żadnego sygnału o miejscu,
 * np. samo "chcę się zapisać"). Tu sygnał JEST — klient wymienia realne miejsce — tylko go nie
 * mamy w bazie. Zadanie modelu to nie "zgadnij", tylko "czy to miejsce leży wyraźnie blisko
 * jednego z tych konkretnych adresów, a jeśli nie masz pewności, powiedz, że nie wiesz".
 *
 * Dwie warstwy zabezpieczeń przed halucynacją:
 * 1. Prompt wprost pozwala i zachęca do odpowiedzi "nie wiem" (temperature: 0, bez zgadywania).
 * 2. Wołający w voice.js i tak traktuje każdy wynik stąd jak zwykły landmark — z obowiązkowym
 *    pytaniem o potwierdzenie do klienta, nigdy z cichym, pewnym trafieniem. Błąd modelu (albo
 *    złe zrozumienie geografii) kosztuje więc najwyżej jedno dodatkowe pytanie, nie złe zgłoszenie.
 *
 * @param {string} userSpeech - transkrybowana wypowiedź klienta
 * @param {Array<{name: string, district: string, landmarkSummary?: string}>} locations - salony z konfiguracji
 * @returns {Promise<string|null>} - DOKŁADNA nazwa salonu z listy (zweryfikowana), albo null
 */
async function matchLandmarkToSalon(userSpeech, locations) {
  if (!userSpeech || !locations || locations.length === 0) return null;

  const salonList = locations
    .map((l) => `- ${l.name} (${l.district})${l.landmarkSummary ? `: ${l.landmarkSummary}` : ""}`)
    .join("\n");

  const prompt = `Klient dzwoni do sieci salonów barberskich w Krakowie i mówi, gdzie jest umówiony, wymieniając jakieś miejsce lub punkt orientacyjny — ale to konkretne miejsce NIE jest zapisane wprost w naszej bazie. Sprawdź, czy na podstawie Twojej wiedzy o topografii Krakowa to miejsce leży WYRAŹNIE blisko JEDNEGO z poniższych salonów.

Salony:
${salonList}

Zasady:
- Jeśli jesteś w miarę pewny, który salon jest najbliżej, odpowiedz WYŁĄCZNIE dokładną nazwą tego salonu, dosłownie tak jak jest zapisana na liście powyżej (te same spacje, wielkość liter) — nic więcej, żadnego komentarza.
- Jeśli NIE masz pewności, wypowiedź nie wspomina żadnego realnego miejsca w Krakowie, albo pasowałaby do kilku salonów naraz, odpowiedz dokładnie: BRAK
- Lepiej szczerze odpowiedzieć BRAK niż zgadywać "na oślep" — błędne dopasowanie skieruje zgłoszenie do złego salonu.`;

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const completion = await getOpenAI().chat.completions.create({
    model,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: userSpeech },
    ],
    max_tokens: 40,
    temperature: 0,
  });

  const text = (completion.choices[0].message.content || "").trim();
  if (!text || text.toUpperCase() === "BRAK") return null;

  // Model MUSI zwrócić dokładnie jedną z podanych nazw — jeśli sparafrazował, skrócił albo
  // wymyślił coś spoza listy, to sygnał halucynacji, a nie prawdziwego dopasowania. Odrzucamy
  // zamiast próbować dopasować "w przybliżeniu".
  const matched = locations.find((l) => l.name === text);
  return matched ? matched.name : null;
}

module.exports = { getAIResponse, classifyIntent, extractLocationPhrase, matchLandmarkToSalon };
