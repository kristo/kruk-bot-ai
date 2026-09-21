/**
 * Natychmiastowe odpowiedzi na najczęstsze pytania — od Krzysztofa, 15.09.2026, po pomiarach
 * opóźnień: odpowiedź FAQ przez OpenAI to mediana ~2,2 s (gpt-4o) / ~0,8 s (gpt-4o-mini), mimo że
 * pytanie dotyczy danych, które i tak mamy na stałe w salon.js. Tutaj odpowiedź powstaje w ~0 ms.
 *
 * Ta sama filozofia, co przy rozpoznawaniu intencji i lokalizacji: deterministycznie, gdy sprawa
 * jest jednoznaczna, AI jako fallback we wszystkim pozostałym. Zasada nadrzędna: LEPIEJ ODDAĆ
 * PYTANIE DO AI NIŻ ODPOWIEDZIEĆ ŹLE. Każda wątpliwość (dwa tematy naraz, niejednoznaczna usługa,
 * pytanie o konkretny salon) kończy się zwróceniem null.
 */
const salonConfig = require("./../config/salon");

// Rozpoznawanie mowy bywa niekonsekwentne w polskich znakach diakrytycznych ("strzyzenie" vs
// "strzyżenie"), a w salon.js aliasy są już zapisane w obu wariantach — tutaj normalizujemy raz
// i dopasowujemy do wersji bez ogonków.
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/\s+/g, " ")
    .trim();
}

const TOPIC_PATTERNS = {
  hours: /godzin|otwar|czynn|zamyka|otwiera|do ktorej|od ktorej/,
  price: /cena|ceny|cennik|cenowo|kosztuje|koszt|ile za|ile place|ile sie placi|ile placi/,
  voucher: /voucher|bon podarunkow|bony podarunkow|karta podarunkow|karte podarunkow|prezent/,
  branches: /ile (macie |jest |)salon|ile ich (macie|jest)|gdzie jestescie|gdzie sie znajdujecie|jakie (macie |)adresy|ile oddzial/,
};

// Samo "pracujecie" NIE wystarcza, żeby uznać pytanie za dotyczące godzin — "na jakich
// kosmetykach pracujecie?" dostawało wtedy odpowiedź o godzinach otwarcia. Ale w połączeniu ze
// wskazaniem dnia ("czy w sobotę pracujecie?") to już jednoznaczne pytanie o czas pracy.
const WORK_VERB_REGEX = /pracuj|robicie/;

function detectTopics(normalized) {
  const topics = Object.entries(TOPIC_PATTERNS)
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([topic]) => topic);

  if (!topics.includes("hours") && WORK_VERB_REGEX.test(normalized) && mentionsDay(normalized)) {
    topics.push("hours");
  }
  return topics;
}

function mentionsDay(normalized) {
  if (/dzis|dzisiaj|jutro|teraz/.test(normalized)) return true;
  return WEEKDAY_PATTERNS.some(([, pattern]) => pattern.test(normalized));
}

// Pytanie o konkretny salon ("gdzie jesteście na Krowodrzy?") oddajemy do AI, które widzi dane
// wszystkich lokalizacji. Dopasowujemy po RDZENIU nazwy, nie po pełnym słowie — klienci mówią
// odmienioną formą ("na Urzędniczej", "z Prądnickiej"), a samo `includes("urzednicza")` takiej
// formy nie łapie. Ta sama sztuczka co wordStem w voice.js.
function mentionsSpecificLocation(normalized) {
  return (salonConfig.locations || []).some((location) => {
    const candidates = [location.name, location.district, ...(location.aliases || [])];
    return candidates.some((candidate) =>
      normalize(candidate)
        .split(/[\s/,]+/)
        .some((word) => {
          if (word.length <= 4 || /^\d/.test(word)) return false;
          const stem = word.length > 5 ? word.slice(0, word.length - 3) : word;
          return normalized.includes(stem);
        })
    );
  });
}

// Dopasowanie po rdzeniu, bo klient powie "w sobotę", "na sobotę", "soboty" — a wzorce i tak
// widzą tekst po normalizacji, czyli bez polskich znaków ("sobotę" -> "sobote").
const WEEKDAY_PATTERNS = [
  ["poniedziałek", /poniedzial/],
  ["wtorek", /wtor(ek|ki|ku)/],
  ["środa", /srod/],
  ["czwartek", /czwart/],
  ["piątek", /piat(ek|ki|ku)/],
  ["sobota", /sobot/],
  ["niedziela", /niedziel/],
];

const WEEKDAY_BY_INDEX = [
  "niedziela",
  "poniedziałek",
  "wtorek",
  "środa",
  "czwartek",
  "piątek",
  "sobota",
];

function warsawWeekday(offsetDays = 0) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + offsetDays);
  const warsawDayName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Warsaw",
    weekday: "short",
  }).format(now);
  const index = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(warsawDayName);
  return WEEKDAY_BY_INDEX[index];
}

// Godziny są w salon.js wspólne dla wszystkich lokalizacji (tak samo mówi prompt AI), więc
// odpowiedź nie zależy od tego, o który salon chodzi.
function formatHours(day) {
  const value = salonConfig.hours[day];
  if (!value) return null;
  const when = dayPhrase(day);
  if (/nieczynne/i.test(value)) return `${when} mamy nieczynne.`;
  return `${when} pracujemy od ${spokenRange(value)}.`;
}

// Gotowa fraza z przyimkiem — "we wtorki" (nie "w wtorki"), reszta dni bierze zwykłe "w".
function dayPhrase(day) {
  const phrases = {
    poniedziałek: "W poniedziałki",
    wtorek: "We wtorki",
    środa: "W środy",
    czwartek: "W czwartki",
    piątek: "W piątki",
    sobota: "W soboty",
    niedziela: "W niedziele",
  };
  return phrases[day] || `W ${day}`;
}

// "8:00–20:00" -> "ósmej do dwudziestej" brzmi sztucznie; zostawiamy cyfry, ale zamieniamy
// półpauzę na słowo, żeby TTS nie przeczytał jej jako pauzy ani nie połknął.
function spokenRange(range) {
  return String(range).replace(/\s*[–-]\s*/, " do ");
}

// Skróty z cennika ("90 zł", "45 min") rozwijamy do pełnych słów — przez telefon TTS potrafi
// przeczytać skrót dosłownie, a odmiana i tak zależy od liczby ("2 złote" vs "5 złotych").
// Uwaga: po "zł" NIE wolno dać \b — w JS \b zna tylko ASCII, więc po "ł" przed spacją granica
// słowa w ogóle nie zachodzi i wzorzec nigdy się nie dopasowywał (ta sama pułapka, co przy
// DISORIENTED_REGEX w voice.js). Zamiast tego jawnie wykluczamy dalsze litery.
function expandUnits(value) {
  return String(value)
    .replace(/(\d+)\s*zł(?![a-ząćęłńóśźż])/gi, (_, n) => `${n} ${polishForm(Number(n), ["złoty", "złote", "złotych"])}`)
    .replace(/(\d+)\s*min(?![a-ząćęłńóśźż])/gi, (_, n) => `${n} ${polishForm(Number(n), ["minuta", "minuty", "minut"])}`);
}

function polishForm(count, [one, few, many]) {
  if (count === 1) return one;
  const lastTwo = count % 100;
  const last = count % 10;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

function answerHours(normalized) {
  if (/dzis|dzisiaj|teraz|w tej chwili|obecnie/.test(normalized)) {
    return formatHours(warsawWeekday(0));
  }
  if (/jutro/.test(normalized)) {
    return formatHours(warsawWeekday(1));
  }

  const mentionedDays = WEEKDAY_PATTERNS.filter(([, pattern]) => pattern.test(normalized));
  // Pytanie o dwa różne dni naraz oddajemy do AI — jedno zdanie tego sensownie nie obsłuży.
  if (mentionedDays.length === 1) {
    return formatHours(mentionedDays[0][0]);
  }
  if (mentionedDays.length > 1) return null;

  return "Od poniedziałku do piątku pracujemy od 8:00 do 20:00, w soboty od 8:00 do 16:00. W niedziele mamy nieczynne.";
}

// Kolejność MA ZNACZENIE — warianty złożone muszą być sprawdzane przed prostymi, inaczej
// "strzyżenie z brodą" złapie się na samo "strzyżenie" i podamy cenę za połowę usługi.
// Celowo pomijamy tu tonowanie (pięć różnych wariantów cenowych) — takie pytanie idzie do AI.
const SERVICE_PATTERNS = [
  [/tata.{0,15}syn|syn.{0,15}tata|ojciec.{0,15}syn/, "Tata + Syn (5–12 lat) – strzyżenie"],
  [/dziec|syna\b|synka|chlopca|malego/, "Strzyżenie dziecka 5–12 lat"],
  [/dlug(ich|ie) wlos.{0,12}(broda|brode)|dlugie wlosy i broda/, "Strzyżenie długich włosów + broda"],
  [/dlug(ich|ie) wlos/, "Strzyżenie długich włosów (od 10 cm)"],
  [/buzzcut.{0,10}(broda|brode)/, "Buzzcut + broda"],
  [/buzzcut/, "Buzzcut (maszynka cieniowanie)"],
  [/maszynk.{0,15}(broda|brode)/, "Maszynka jedna długość + broda"],
  [/maszynk/, "Strzyżenie maszynką – jedna długość"],
  [/lys|na lyso|golark/, "Łysa głowa golarką"],
  [/stylizacj/, "Stylizacja włosów"],
  [/combo|strzyzenie (i|z|plus|\+) brod|brod.{0,12}(i|z|plus|\+) strzyzenie/, "Strzyżenie + broda (combo)"],
  [/strzyzenie|strzyc|ostrzyc|wlos/, "Strzyżenie (haircut)"],
  [/brod|zarost/, "Broda (beard)"],
];

function findService(normalized) {
  for (const [pattern, serviceName] of SERVICE_PATTERNS) {
    if (pattern.test(normalized)) {
      return (salonConfig.services || []).find((s) => s.name === serviceName) || null;
    }
  }
  return null;
}

function answerPrice(normalized) {
  // Tonowanie ma pięć wariantów cenowych — bez dopytania nie da się odpowiedzieć uczciwie.
  if (/tonowani|tonowanie|koloryzacj|farbowani/.test(normalized)) return null;

  const service = findService(normalized);
  if (service) {
    const name = service.name.replace(/\s*\([^)]*\)/, "");
    return `${name} kosztuje ${expandUnits(service.price)} i trwa około ${expandUnits(service.duration)}.`;
  }

  // Pytanie o cennik ogólnie — pełna lista 19 pozycji jest nie do słuchania przez telefon,
  // więc podajemy trzy najpopularniejsze i odsyłamy po resztę.
  return "Strzyżenie kosztuje 90 złotych, broda 70 złotych, a strzyżenie z brodą 130 złotych. Pełny cennik znajdziesz w aplikacji Booksy.";
}

function hasPerLocationHours() {
  return (salonConfig.locations || []).some((location) => location.hours);
}

function answerVoucher() {
  return "Tak, mamy vouchery podarunkowe. Wystarczy podejść do dowolnego naszego salonu, barber wypisze go od ręki, a wykorzystasz go w każdym salonie Kruk Barbershop.";
}

function answerBranches() {
  const count = salonConfig.declaredBranchCount || (salonConfig.locations || []).length;
  return `Mamy ${count} salonów w Krakowie — między innymi na Krowodrzy, w Nowej Hucie, na Dębnikach i w Mistrzejowicach. Powiedz, w jakiej okolicy jesteś, a podpowiem najbliższy.`;
}

/**
 * @param {string} speech - transkrybowana wypowiedź klienta
 * @returns {string|null} - gotowa odpowiedź albo null, gdy pytanie ma iść do AI
 */
function answerFaqDeterministic(speech) {
  const normalized = normalize(speech);
  if (!normalized) return null;

  const topics = detectTopics(normalized);
  // Zero tematów = to nie jest pytanie, które tu obsługujemy.
  // Więcej niż jeden ("o której otwieracie i ile kosztuje strzyżenie?") = odpowiedź musiałaby
  // łączyć dwa wątki; sklejanie dwóch szablonów brzmi sztucznie, więc oddajemy to do AI.
  if (topics.length !== 1) return null;

  const topic = topics[0];

  // "Gdzie jesteście na Krowodrzy?" to pytanie o konkretne salony — oddajemy do AI, które widzi
  // pełną listę lokalizacji. Ceny, godziny i vouchery są wspólne dla całej sieci, więc tam
  // wzmianka o salonie niczego nie zmienia.
  if (topic === "branches" && mentionsSpecificLocation(normalized)) return null;

  // Godziny w salon.js są jedne dla wszystkich lokalizacji, więc "o której zamykacie na
  // Urzędniczej?" ma tę samą odpowiedź co pytanie ogólne. Gdyby kiedyś doszły godziny per salon,
  // ten warunek sam z siebie zacznie oddawać takie pytania do AI, zamiast po cichu odpowiadać źle.
  if (topic === "hours" && mentionsSpecificLocation(normalized) && hasPerLocationHours()) {
    return null;
  }

  if (topic === "hours") return answerHours(normalized);
  if (topic === "price") return answerPrice(normalized);
  if (topic === "voucher") return answerVoucher();
  if (topic === "branches") return answerBranches();
  return null;
}

module.exports = { answerFaqDeterministic, _test: { normalize, detectTopics, findService } };
