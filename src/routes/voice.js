const express = require("express");
const twilio = require("twilio");
const salonConfig = require("../config/salon");
const { getAIResponse, classifyIntent, extractLocationPhrase, matchLandmarkToSalon } = require("../services/ai");
const { answerFaqDeterministic } = require("../services/faq");
const { logCallTurn, logCallbackRequest } = require("../services/callLog");
const {
  getTwilioClient,
  markMessageSent,
  getBookingInternalRecipients,
  getLateRecipients,
  notifyInternalRecipients,
} = require("../services/notify");

const router = express.Router();

// Trwały zapis każdej tury rozmowy — od Krzysztofa, 13.09.2026 ("brak realnego wglądu w jakość
// rozmów"). Jedna wspólna trasa zamiast wołania tego w każdym handlerze osobno; logCallTurn
// nigdy nie rzuca (patrz komentarz w callLog.js), więc to nie może wywrócić obsługi połączenia.
router.use((req, _res, next) => {
  // Sprawdzamy podpis Twilio TU, mimo że każda trasa i tak robi to samo poniżej — inaczej
  // sfałszowane/niepodpisane żądania trafiałyby do dziennika rozmów, zanim właściwy handler
  // zdążyłby je odrzucić. Nie odrzucamy żądania tutaj (to wciąż robi handler trasy) — po prostu
  // nie logujemy tego, co nie przejdzie weryfikacji.
  if (validateTwilioRequest(req)) {
    logCallTurn({
      callSid: req.body?.CallSid,
      route: req.path,
      from: req.body?.From,
      speech: req.body?.SpeechResult,
    });
  }
  next();
});

const POLISH_LANGUAGE = "pl-PL";
const POLISH_VOICE = process.env.TTS_VOICE || "Polly.Jacek";
// Polski głos (np. Polly.Ewa-Neural) nie mówi płynnie po angielsku — do krótkich zdań po angielsku
// używamy osobnego, natywnego angielskiego głosu.
const ENGLISH_VOICE = process.env.TTS_VOICE_EN || "Polly.Joanna-Neural";
const TTS_RATE = process.env.TTS_RATE || "115%";

const GATHER_TIMEOUT = 7;
const SPEECH_TIMEOUT = "auto";
const MAX_NO_INPUT_RETRIES = 2;
const MAX_FAQ_TURNS = 3;
const OPS_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // nie częściej niż raz na 30 min, żeby awaria Twilio nie zasypała powiadomieniami
let lastOpsAlertAt = 0;

async function sendOpsAlert(message) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;

  const now = Date.now();
  if (now - lastOpsAlertAt < OPS_ALERT_COOLDOWN_MS) return;
  lastOpsAlertAt = now;

  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      // Nagłówki HTTP muszą być ByteString (0-255) — polskie znaki tu wysadzają fetch, więc tytuł zostaje po angielsku.
      headers: { Title: "Kruk Bot alert" },
      body: message,
    });
  } catch (err) {
    console.error("Ops alert (ntfy) error:", err.message || err);
  }
}

const CLOSING_MESSAGE = "Dziękujemy za kontakt. Rozwijamy się dla Twojej wygody! Do zobaczenia.";
const BOOKSY_LINK =
  "https://booksy.com/pl-pl/instant-experiences/widget/93101,16323,295786,214909,69423,300487,346265,353769,356253?instant_experiences_enabled=true&ig_ix=true";

// Informacja o nagrywaniu USUNIĘTA 16.09.2026 na wyraźną decyzję Damiana i Wiktorii ("nie musimy
// nagrywać i tego nie róbmy", "usuńmy to zdanie o nagrywaniu"). Powód merytoryczny: bot nigdy nie
// nagrywał dźwięku — nie ma tu werbu <Record>, jest tylko rozpoznawanie mowy w <Gather>, więc
// zapowiedź była nieprawdziwa. Zapisujemy natomiast TRANSKRYPTY wypowiedzi (patrz callLog.js
// i /admin/calls), co jest przetwarzaniem danych, tylko innego rodzaju niż nagranie.
// Efekt uboczny: powitanie skraca się o ~5 sekund, których klient nie mógł przerwać.

// Treść wg diagramu Damiana i Wiktorii (16.09.2026). Zapowiedź "w każdej chwili możesz poprosić
// o konsultanta" USUNIĘTA 17.09.2026 na ich uwagę z testów na żywo — w diagramie jej nie ma.
// Prośba o człowieka w dowolnym momencie rozmowy nadal jest rozpoznawana (TRANSFER_KEYWORDS_REGEX),
// tylko od 18.09.2026 NIE łączy już na żywo — patrz respondWithHumanCallbackPromise: zawsze
// obietnica oddzwonienia, bez próby <Dial> (decyzja Krzysztofa — rezygnacja z przekierowania).
// Celowo krótkie: Say przed Gather nie jest przerywalny (patrz addSpeechGather), a 11.09.2026
// zaobserwowano kilka połączeń rozłączonych jeszcze w trakcie samego powitania.
const INCOMING_PROMPT =
  "Hej, tu automatyczny asystent Kruk Barbershop. Powiedz, w jakiej sprawie dzwonisz: chcesz umówić wizytę, poinformować o spóźnieniu czy masz inną sprawę?";

const LATE_PROMPT = "Podaj adres salonu, do którego jesteś umówiony.";

// Gdy z wypowiedzi nie da się wyłuskać ŻADNEGO salonu, powtarzanie "powiedz jeszcze raz adres"
// prowadziło donikąd — klient, który nie pamięta adresu, nie poda go też za drugim razem
// ("w centrum" kończyło się dokładnie tak). Zamiast tego zawężamy obszarami. Od Wiktorii,
// 16.09.2026: "może jakby zapytał huta/centrum/krowodrza i później zawężał".
// UWAGA: ta lista musi obejmować wszystkie salony — pilnuje tego test w location-matching.test.js.
// Pytamy o obszar DOPIERO po nieudanym rozpoznaniu: kto od razu mówi "spóźnię się na Dywizjonu",
// dostaje zgłoszenie bez tego pytania ("żeby też sztucznie nie wydłużać rozmowy" — Wiktoria).
// Konkretna liczba salonów zamieniona na "kilka lokalizacji" — od Damiana, 17.09.2026: podawanie
// liczby ("mamy 9 salonów"), a zaraz potem wymienianie tylko 4 obszarów, brzmiało niespójnie.
//
// "Prądnik Czerwony" dodany jako osobny obszar — od Krzysztofa, 21.09.2026. Salon Kniaźnina 1 ma
// w konfiguracji district="Nowa Huta, osiedle Oświecenia" (i tą drogą był już OSIĄGALNY przez samo
// "w Nowej Hucie" — patrz DISTRICT_KEYWORDS/test location-matching.test.js), ale realny dzwoniący
// z Prądnika Czerwonego nie kojarzy tej okolicy z Nową Hutą i nie wpadnie na to, żeby tak
// odpowiedzieć na to pytanie — administracyjnie to osobna dzielnica. Wymieniamy więc obszar wprost,
// zamiast liczyć na to, że ktoś "przetłumaczy sobie" swoją okolicę na Nową Hutę.
const LATE_AREA_PROMPT =
  "Mamy kilka lokalizacji w Krakowie. Jesteś umówiony w Nowej Hucie, na Krowodrzy, w centrum, na Dębnikach czy na Prądniku Czerwonym?";
const LATE_AREA_RETRY_PROMPT = "Powiedz proszę nazwę ulicy albo dzielnicy.";
// Krótkie potwierdzenie zaraz po rozpoznaniu zgłoszenia + wzmianka o kolejnym kliencie —
// od klienta za pośrednictwem Wiktorii/Damiana, 11.09.2026.
const LATE_CONFIRMATION = "Rozumiem, przekazuję informację o spóźnieniu do salonu.";
const LATE_WARNING =
  "Pamiętaj: przy spóźnieniu powyżej 10-15 minut, w zależności od usługi, barber może nie zdążyć Cię obsłużyć — zwłaszcza jeśli zaraz po Tobie ma kolejnego klienta. Pospiesz się, do zobaczenia!";

// Przeprojektowane 12.09.2026 wg relacji testera (przez Wiktorię/Damiana): sprawy, których bot nie
// może sam załatwić (np. odwołanie/zmiana wizyty), lądowały tu bez żadnego wyjaśnienia dlaczego, i
// bez zebrania czegokolwiek, co przyspieszyłoby oddzwonienie Wiktorii. Treść niemal dosłownie wg
// szkicu klienta: wyjaśniamy ograniczenie Booksy, prosimy o dane do identyfikacji wizyty i osoby,
// i przypominamy o samoobsłudze w aplikacji Booksy.
// Skrócone 16.09.2026 na prośbę Wiktorii: prośba o imię i nazwisko albo profil w Booksy odpadła
// ("myślę że imię i nazwisko nie jest potrzebne, ja sobie wyszukam") — i tak dostaje numer
// dzwoniącego, a po nim znajdzie klienta sama. Zostaje samo sedno: po co pytamy i co się stanie
// dalej. Skraca ten fragment z ~25 do ~11 sekund, których klient nie może przerwać.
const OTHER_BOOKSY_LIMIT_PROMPT =
  "Ze względu na ograniczenia systemu Booksy nie załatwię tego sam, ale od razu przekażę sprawę Wiktorii. Powiedz krótko, o co chodzi — Wiktoria oddzwoni. Pamiętaj też, że rezerwacje, odwołania i zmiany możesz zrobić samodzielnie w aplikacji Booksy.";
const OTHER_GENERAL_PROMPT =
  "Jasne, przekażę sprawę Wiktorii. Powiedz krótko, o co chodzi — Wiktoria oddzwoni najszybciej, jak to możliwe.";

// Od Wiktorii/Damiana, 17.09.2026 — patrz komentarz przy COOPERATION_REGEX. Celowo BEZ obietnicy
// oddzwonienia: Wiktoria wprost powiedziała, że większość takich telefonów to nie wymaga żadnej
// odpowiedzi z jej strony, więc bot nie może obiecywać czegoś, czego zespół nie planuje zrobić.
const COOPERATION_PROMPT = "Jasne — w skrócie, czego miałaby dotyczyć ta współpraca?";
const COOPERATION_NO_INPUT_PROMPT = "Nie dosłyszałem. Powiedz proszę krótko, czego miałaby dotyczyć współpraca.";

// JEDNO pytanie zamknięte zamiast potrójnego ("czy to wyczerpująca odpowiedź, czy mogę jeszcze
// w czymś pomóc, albo wolisz, żeby Wiktoria oddzwoniła?"), na które "tak" nie znaczyło nic
// konkretnego. Wg Wiktorii, 16.09.2026: "zapytać czy klient dostał satysfakcjonującą odpowiedź,
// i jeśli nie to wtedy że ja zadzwonię, a jak tak albo się nie odezwie to temat zamknięty".
// UWAGA: ta zmiana ODWRACA znaczenie "nie" w tej trasie — przy starym pytaniu "nie" znaczyło
// "nie potrzebuję już nic" (i kończyło rozmowę), przy nowym znaczy "odpowiedź niewystarczająca"
// (i ma skutkować oddzwonieniem). Klasyfikacją zajmuje się classifyFaqFollowup niżej.
const FAQ_FOLLOWUP_PROMPT = "Czy to wyczerpująca odpowiedź?";
const FAQ_FALLBACK_ANSWER = `Przepraszam, mam teraz problem z odpowiedzią. Zadzwoń proszę pod numer ${salonConfig.phone} lub napisz na adres ${salonConfig.email}.`;

// Odpowiedź "nie" na FAQ_FOLLOWUP_PROMPT (pytanie zamknięte "czy mogę jeszcze w czymś pomóc, albo
// wolisz, żeby Wiktoria oddzwoniła?") nie pasuje do żadnego intentu (ZAPIS/SPOZNIENIE/PYTANIE), więc
// lądowała w domyślnej gałęzi "przekazuję do Wiktorii" — dokładnie odwrotnie niż to, co klient
// powiedział (że NIE potrzebuje już pomocy). Zgłoszone przez testera za pośrednictwem
// Wiktorii/Damiana, 12.09.2026: "nie było już od tego momentu konstruktywnej rozmowy".
// Uwaga: "nie" musi być na początku CAŁEJ wypowiedzi i albo stanowić ją samodzielnie, albo być od
// razu followed by podziękowaniem — inaczej "Nie wiem czy macie wolne miejsca w sobotę" (prawdziwe,
// merytoryczne pytanie zaczynające się od "nie") też zostałoby błędnie uznane za rezygnację.
const GENERAL_DECLINE_REGEX = /(^nie[.,!]?$|^nie,? dzięk|nie trzeba|nieważne|to wszystko|wystarczy|^dzięk)/i;

// Odpowiedź na pytanie zamknięte ("Chodzi Ci o salon X?", "Czy mam przekazać to zgłoszenie?").
// Poprzednia wersja wymagała znaku PO słowie "nie" (wzorzec nie[\s,.]), więc samo "Nie" —
// najczęstsza możliwa odpowiedź, zwracana przez rozpoznawanie mowy bez kropki — przechodziło jako
// POTWIERDZENIE i bot robił dokładnie odwrotnie, niż prosił klient: wysyłał zgłoszenie mimo odmowy
// albo kierował je do salonu, który klient właśnie odrzucił. Znalezione w przeglądzie 15.09.2026,
// ta sama klasa błędu co GENERAL_DECLINE_REGEX wyżej (zgłoszenie testera z 12.09.2026).
//
// "nie" liczy się jako odmowa TYLKO na początku wypowiedzi — tam pada odpowiedź na pytanie.
// "Tak, bo nie mogę się dodzwonić" to potwierdzenie z wyjaśnieniem, nie odmowa. Z drugiej strony
// nie wolno tu użyć samego dopasowania podciągu "nie": słowo "mnie" ("dla mnie tak") i nazwa
// salonu "Niepodległości" zawierają je w środku.
const CLOSED_QUESTION_AFFIRMATIVE_REGEX =
  /^(tak\b|no tak\b|zgadza|dokładnie|owszem|jasne|pewnie|ano\b|nie ma (sprawy|problemu))/i;
const CLOSED_QUESTION_DECLINE_REGEX = /^(no\s+|ale\s+|e+\s+)?nie\b/i;

// Odpowiedź na FAQ_FOLLOWUP_PROMPT ("Czy to wyczerpująca odpowiedź?"). Zwraca:
//   "zamknij"   — klient zadowolony albo nie chce już nic (kończymy rozmowę),
//   "oddzwon"   — odpowiedź niewystarczająca (zgłoszenie do Wiktorii),
//   "pytanie"   — to nie jest odpowiedź tak/nie, tylko kolejne pytanie (normalny routing).
//
// Kolejność sprawdzania jest tu najważniejsza: "nie, dziękuję" i "nie, to mi nie wystarczy"
// zaczynają się identycznie, a znaczą coś przeciwnego. Zmierzone na żywym kodzie 16.09.2026:
// "Tak, dziękuję" generowało Wiktorii zgłoszenie (klient był zadowolony!), a "Nie, to mi nie
// wystarczy" kończyło rozmowę — bo fraza zawierała słowo "wystarczy", które miało łapać zadowolenie.
const FAQ_THANKS_CLOSING_REGEX = /\b(dzięk|dziekuj)/i;
const FAQ_DISSATISFIED_REGEX =
  /nie (wystarcz|odpowiada|rozumiem|o to|na to|bardzo|za bardzo|do końca)|niewystarczaj|to nie (jest )?(odpowiedź|to)|nadal nie|w ogóle nie/i;
const FAQ_SATISFIED_REGEX =
  /^(tak|ok\b|okej|dobra|dobrze|jasne|super|świetnie|rozumiem|w porządku)/i;
// Wyrażenia zadowolenia, które nie muszą stać na początku ("to mi wystarczy", "tyle mi wystarcza").
// Bezpieczne dopiero PO bramce niezadowolenia, która łapie zaprzeczone "nie wystarczy".
const FAQ_SUFFICIENT_REGEX = /\b(wystarcz|to wszystko|w zupełności|nic więcej)/i;

// Samo "nie" znaczy "niewystarczająco" tylko jako KRÓTKA odpowiedź na pytanie zamknięte.
// Dłuższa wypowiedź zaczynająca się od "nie" to zwykle nowa sprawa ("Nie chcę już czekać, chcę
// się od razu umówić") — bez tego limitu trafiałaby do Wiktorii zamiast do zapisu, czyli
// wracałby błąd naprawiony 12.09.2026. Ten sam pomysł co SHORT_AFFIRMATION_MAX_WORDS wyżej.
const FAQ_SHORT_DENIAL_MAX_WORDS = 3;

function classifyFaqFollowup(speechResult) {
  const answer = (speechResult || "").trim().toLowerCase();
  if (!answer) return "zamknij";

  // Najpierw jawne niezadowolenie — także wtedy, gdy klient grzecznie dziękuje przy okazji.
  if (FAQ_DISSATISFIED_REGEX.test(answer)) return "oddzwon";

  // Podziękowanie w dowolnej formie ("nie, dziękuję", "dzięki, to wszystko") zamyka temat.
  if (FAQ_THANKS_CLOSING_REGEX.test(answer)) return "zamknij";

  if (FAQ_SATISFIED_REGEX.test(answer) || FAQ_SUFFICIENT_REGEX.test(answer)) return "zamknij";

  // Samo "nie" przy pytaniu "czy to wyczerpująca odpowiedź?" znaczy "nie wystarczyło mi".
  // To ODWROTNIE niż przy poprzednim, potrójnym brzmieniu pytania — patrz komentarz przy
  // FAQ_FOLLOWUP_PROMPT. Tylko dla krótkich odpowiedzi, patrz FAQ_SHORT_DENIAL_MAX_WORDS.
  const wordCount = answer.split(/\s+/).length;
  if (wordCount <= FAQ_SHORT_DENIAL_MAX_WORDS && /^(no\s+|ale\s+)?nie\b/i.test(answer)) return "oddzwon";

  return "pytanie";
}

// Cisza celowo NIE jest odmową — lepiej zgłosić na podstawie sensownej podpowiedzi niż zgubić
// całe zgłoszenie (patrz komentarze przy trasach *-confirm).
function isDeclinedAnswer(speechResult, extraDeclineRegex) {
  const answer = (speechResult || "").trim().toLowerCase();
  if (!answer) return false;
  if (CLOSED_QUESTION_AFFIRMATIVE_REGEX.test(answer)) return false;
  if (CLOSED_QUESTION_DECLINE_REGEX.test(answer)) return true;
  return extraDeclineRegex ? extraDeclineRegex.test(answer) : false;
}

// Zachęta do zostawienia uwagi o działaniu bota tuż przed pożegnaniem — od Wiktorii, 09.09.2026.
// Realnie słuchamy odpowiedzi (Gather), a nie tylko rzucamy hasło w powietrze przed rozłączeniem.
// Przeformułowane 12.09.2026: poprzednia wersja pytała "czy masz uwagi?" — tester odpowiedział
// samym "tak, mam uwagi", co bot połknął jako CAŁĄ treść uwagi i się pożegnał, nigdy nie usłyszawszy
// właściwej uwagi (patrz też SHORT_AFFIRMATION_REGEX w /voice/feedback, druga linia obrony).
const FEEDBACK_PROMPT = "Zanim się rozłączymy — jeśli masz jakieś uwagi do mojego działania, powiedz je teraz.";

// Druga linia obrony na wypadek, gdyby ktoś mimo wszystko odpowiedział samym "tak"/"mam uwagi" bez
// treści — dopytujemy o samą treść zamiast połknąć to jako całą uwagę. Patrz komentarz przy
// FEEDBACK_PROMPT, zgłoszenie testera 12.09.2026.
// Dopasowanie na START wypowiedzi + limit liczby słów (nie ścisłe dopasowanie całości) — "Tak, mam
// uwagi" ma 3 słowa i musi się złapać, a dłuższe zdanie zaczynające się od "Tak, uważam że..." to
// już prawdziwa treść uwagi i NIE powinno wywoływać dopytania.
const SHORT_AFFIRMATION_REGEX = /^(tak|mam|no tak|owszem|jasne|pewnie|jedn[ąa])\b/i;
const SHORT_AFFIRMATION_MAX_WORDS = 4;

// Klient chce ODWOŁAĆ/ZMIENIĆ istniejącą wizytę — to NIE jest ZAPIS (nowej wizyty), więc musi być
// sprawdzane przed regexem ZAPIS (który złapałby np. "termin" w "zmienić termin"). Bez tego rozmówca
// proszący o odwołanie dostawał ofertę zapisu na NOWĄ wizytę zamiast pomocy — zgłoszone przez
// testera za pośrednictwem Wiktorii/Damiana, 12.09.2026.
const CANCELLATION_REGEX =
  /(odwoł|anuluj|anulowa[ćc]|przełoż|zmieni[ćc] termin|nie mogę (przyjść|dotrzeć)|nie dam rady przyjść)/i;

// Telefony firm oferujących coś salonowi (kosmetyki, sprzątanie, marketing itp.) — od
// Damiana/Wiktorii, 17.09.2026: "najwięcej telefonów to wciskanie kosmetyków, sprzątania czy
// innych takich, to żebym wiedziała że nie muszę oddzwaniać... a czasem może ktoś powie coś
// sensownego, to żeby przekazywał do mnie". W przeciwieństwie do reszty tras tutaj bot NIE
// obiecuje oddzwonienia — tylko przekazuje treść, a Wiktoria/Damian sami decydują, czy odpowiedzieć.
// Celowo BEZ ogólnego "ofert" — to słowo jest już w FAQ_KEYWORDS_REGEX (klienci pytający "co macie
// w ofercie" o usługi salonu) i złapałoby ich fałszywie. "Współpraca" jest wystarczająco swoistym,
// jednoznacznym sygnałem B2B, którego prawdziwy klient nie użyje.
const COOPERATION_REGEX = /(wsp[oó]łprac|reprezentuj[eę]\s+firm|z ramienia firmy)/i;

// Fraza sygnalizująca, że rozmówca chce rozmawiać z żywym człowiekiem, a nie z botem — działa
// w dowolnym momencie rozmowy, nie tylko na starcie. Od Wiktorii, 09.09.2026.
const TRANSFER_KEYWORDS_REGEX =
  /(konsultant|z (żywym )?(człowiekiem|pracownikiem|kimś)|połącz (mnie )?z|przełącz (mnie )?na|prawdziwą osob|chcę rozmawiać z (kimś|osobą|człowiekiem))/i;


// Słownictwo podpowiadane rozpoznawaniu mowy (atrybut hints w Gather). Powód: 17.09.2026 Wiktoria
// powiedziała "chcę zakupić voucher", a Twilio przetranskrybowało to jako "chcę zapytać
// o ZABEZPIECZENIE" — słowo "voucher" nie istniało w wyniku, więc żaden nasz regex nie miał szans
// i pytanie poleciało do AI, które zmyśliło "odpowiedni dział".
// Twilio przyjmuje do 500 pozycji po max 100 znaków i nie ma za to kary wydajnościowej, więc
// listę budujemy z konfiguracji (nazwy ulic, dzielnice, punkty orientacyjne, usługi) — dzięki temu
// dodanie salonu automatycznie dokłada jego nazwę do podpowiedzi, bez ruszania tego pliku.
const SPEECH_HINT_TERMS = [
  // Słowa, które rozpoznawanie myli najbardziej — zapożyczenia i nazwy własne.
  "voucher",
  "vouchery",
  "bon podarunkowy",
  "karta podarunkowa",
  "Booksy",
  "Kruk Barbershop",
  "barber",
  // Typowe intencje, na których opiera się routing rozmowy.
  "chcę się umówić",
  "umówić wizytę",
  "spóźnię się",
  "odwołać wizytę",
  "przełożyć termin",
  "konsultant",
  "współpraca",
  "nawiązać współpracę",
  // Nazwy obszarów z LATE_AREA_PROMPT — dokładnie te słowa, które bot każe klientowi powtórzyć
  // przy zawężaniu obszarem, więc mają być rozpoznane niezawodnie. Od Krzysztofa, 21.09.2026 —
  // "Prądnik Czerwony" to rzadsza fraza, którą rozpoznawanie bez podpowiedzi łatwiej przekręca,
  // a błędna transkrypcja tu psuje cały sens dopytania o obszar. Kilka krótkich pozycji, więc
  // bezpiecznie mieści się w limicie, który wywrócił produkcję przy pełnej liście 17.09.2026
  // (patrz komentarz w buildSpeechHints) — to NIE jest powrót do tamtej pełnej listy.
  "Nowa Huta",
  "Krowodrza",
  "Dębniki",
  "Prądnik Czerwony",
  // Usługi z cennika.
  "strzyżenie",
  "broda",
  "combo",
  "buzzcut",
  "fade",
  "tonowanie",
  "stylizacja",
  "golenie",
];

function buildSpeechHints() {
  // AWARIA PRODUKCYJNA 17.09.2026: zaraz po wdrożeniu pełnej listy (137 pozycji, ~2 KB — wszystkie
  // nazwy/aliasy/landmarki ze WSZYSTKICH salonów) klienci zaczęli słyszeć komunikat Twilio "we are
  // sorry, an application error has occurred" TUŻ PO POWITANIU — czyli dokładnie tam, gdzie pierwszy
  // raz w rozmowie użyty jest atrybut hints. W logach produkcyjnych ŻADNA z tych rozmów nie
  // doczekała się w ogóle wywołania /voice/intent, co wskazuje, że to Twilio odrzucało naszą
  // odpowiedź, zanim zdążyła do nas wrócić — nie błąd po naszej stronie (nasz własny error handler
  // mówi po polsku, a klient słyszał komunikat Twilio po angielsku).
  // Dokumentacja Twilio deklaruje limit 500 pozycji / 100 znaków KAŻDA, ale nie podaje sumarycznego
  // limitu długości całego atrybutu — więc nie da się tego wykluczyć jako przyczyny. Zamiast
  // dochodzić dokładnej granicy metodą prób na żywych rozmowach klientów, tymczasowo wracamy do
  // małej, ręcznej listy (ta sama, która naprawiła pierwotne zgłoszenie o "voucher" -> "zabezpieczenie"),
  // bez automatycznego dopisywania wszystkich nazw/aliasów/landmarków z konfiguracji. Do ponownego
  // rozważenia OSTROŻNIE, przyrostowo, z realnym telefonem testowym po każdym kroku — nie od razu
  // pełną listą.
  const unique = [...new Set(SPEECH_HINT_TERMS)]
    .filter(Boolean)
    .map((term) => String(term).replace(/,/g, " ").trim())
    .filter((term) => term.length > 1 && term.length <= 100)
    .slice(0, 500);

  return unique.join(",");
}

const SPEECH_HINTS = buildSpeechHints();

function addSpeechGather(twiml, action, promptText) {
  // Say jako OSOBNY werb przed Gather (nie zagnieżdżony w nim) — Twilio zaczyna nasłuchiwać
  // mowy dopiero, gdy ten poprzedzający werb się skończy. Zagnieżdżony w Gather Say jest
  // domyślnie przerywalny ("barge-in") — nasłuchiwanie leci równolegle z odtwarzaniem, więc
  // byle szmer wykryty jako początek mowy ucinał zdanie w połowie (zwłaszcza to pierwsze,
  // przedstawiające bota, i dłuższe odpowiedzi jak lista lokalizacji). Zgłoszone przez klienta
  // za pośrednictwem Wiktorii/Damiana, 10.09.2026.
  if (promptText) {
    sayPl(twiml, promptText);
  }

  const gather = twiml.gather({
    input: "speech",
    language: POLISH_LANGUAGE,
    speechTimeout: SPEECH_TIMEOUT,
    timeout: GATHER_TIMEOUT,
    hints: SPEECH_HINTS,
    action,
    method: "POST",
    actionOnEmptyResult: true,
  });

  return gather;
}

function sayPl(node, text) {
  if (!text) return;
  node.say({ voice: POLISH_VOICE, language: POLISH_LANGUAGE }, toSsml(text));
}

function toSsml(text) {
  const safeText = escapeForSsml(String(text));
  return `<speak><prosody rate="${TTS_RATE}">${safeText}</prosody></speak>`;
}

function escapeForSsml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function finishCall(twiml, messageBeforeClosing) {
  if (messageBeforeClosing) {
    sayPl(twiml, messageBeforeClosing);
  }
  sayPl(twiml, CLOSING_MESSAGE);
  twiml.hangup();
}

// Jak finishCall, ale zamiast od razu się żegnać, dopytuje o uwagi do działania bota — tylko
// w miejscach, gdzie rozmowa faktycznie się naturalnie kończy (nie w defensywnych fallbackach
// po Gather, które i tak prawie nigdy się nie wykonują dzięki actionOnEmptyResult:true).
function finishCallWithFeedbackPrompt(twiml, messageBeforeClosing) {
  if (messageBeforeClosing) {
    sayPl(twiml, messageBeforeClosing);
  }
  addSpeechGather(twiml, `${process.env.BASE_URL}/voice/feedback`, FEEDBACK_PROMPT);
  sayPl(twiml, CLOSING_MESSAGE);
  twiml.hangup();
}

// Numery, pod które bot faktycznie łączy żywą rozmowę na prośbę o konsultanta — dzwonimy
// jednocześnie do obu, żeby zwiększyć szansę, że ktoś odbierze szybko.
// Usunięto damianPhone z tej listy na prośbę Krzysztofa 13.09.2026 — ten numer nadal
// otrzymuje powiadomienia tekstowe (getBookingInternalRecipients), ale przestaje być
// wybierany na żywo przy przełączeniu na konsultanta.
// Klient wprost prosi o rozmowę z człowiekiem — od 18.09.2026 NIE łączymy już na żywo (rezygnacja
// z <Dial>, decyzja Krzysztofa). Wcześniej i tak w większości przypadków kończyło się to na
// /voice/transfer-result z "nikt nie odebrał" -> dokładnie tym samym zgłoszeniem co tutaj, tylko
// po 20 sekundach dzwonienia zamiast od razu. Traktujemy to identycznie jak zgłoszenie "INNE":
// ta sama notyfikacja do zespołu, ten sam wpis w /admin/callbacks, ta sama obietnica oddzwonienia
// — bez próby połączenia po drodze.
function respondWithHumanCallbackPromise(twiml, { speech, from, to, callSid }) {
  const internalPromise = sendOtherNotification({
    callSid,
    from,
    to,
    speech: speech || "(brak treści — prośba o rozmowę z człowiekiem)",
  });

  finishCallWithFeedbackPrompt(twiml, "Wiktoria oddzwoni i doradzi Ci w tej sprawie najszybciej, jak to możliwe.");

  internalPromise.catch((err) => {
    console.error("Human callback request notification error:", err.message || err);
    sendOpsAlert(`Nie udało się wysłać zgłoszenia (prośba o konsultanta): ${err.message || err}`);
  });
}

router.post("/incoming", (req, res) => {
  if (!validateTwilioRequest(req)) {
    return res.status(403).send("Forbidden");
  }

  const twiml = new twilio.twiml.VoiceResponse();

  addSpeechGather(twiml, `${process.env.BASE_URL}/voice/intent?attempt=0`, INCOMING_PROMPT);

  finishCall(twiml, "Nie dosłyszałem odpowiedzi.");
  return res.type("text/xml").send(twiml.toString());
});

router.post("/intent", async (req, res) => {
  if (!validateTwilioRequest(req)) {
    return res.status(403).send("Forbidden");
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || "").trim();
  const attempt = parseInt(req.query.attempt || "0", 10);
  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid;

  if (speech && TRANSFER_KEYWORDS_REGEX.test(speech.toLowerCase())) {
    respondWithHumanCallbackPromise(twiml, { speech, from, to, callSid });
    return res.type("text/xml").send(twiml.toString());
  }

  if (!speech) {
    if (attempt < MAX_NO_INPUT_RETRIES) {
      addSpeechGather(
        twiml,
        `${process.env.BASE_URL}/voice/intent?attempt=${attempt + 1}`,
        "Nie dosłyszałem. Powiedz proszę: umówienie wizyty, spóźnienie albo inna sprawa."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // Kilka nieudanych prób zrozumienia po polsku bywa barierą językową (np. klient mówi po
    // angielsku) — zamiast po cichu się rozłączać, dajemy znać zespołowi, żeby oddzwonić.
    await respondWithLanguageBarrierFallback(twiml, { from, to, callSid });
    return res.type("text/xml").send(twiml.toString());
  }

  if (looksEnglish(speech)) {
    await respondInEnglish(twiml, { speech, from, to, callSid });
    return res.type("text/xml").send(twiml.toString());
  }

  const intent = await resolveIntent(speech);

  if (intent === "ZAPIS") {
    await respondWithBookingQuickLink(twiml, { speech, from, to, callSid });
    return res.type("text/xml").send(twiml.toString());
  }

  if (intent === "SPOZNIENIE") {
    addSpeechGather(
      twiml,
      `${process.env.BASE_URL}/voice/collect-late?attempt=0`,
      LATE_PROMPT
    );
    finishCall(twiml, "Nie usłyszałem, do którego salonu jesteś umówiony.");
    return res.type("text/xml").send(twiml.toString());
  }

  if (intent === "WSPOLPRACA") {
    addSpeechGather(twiml, `${process.env.BASE_URL}/voice/collect-cooperation?attempt=0`, COOPERATION_PROMPT);
    finishCall(twiml, "Nie usłyszałem, czego miałaby dotyczyć współpraca.");
    return res.type("text/xml").send(twiml.toString());
  }

  if (intent === "PYTANIE") {
    await respondWithFaqAnswer(twiml, speech, 1);
    return res.type("text/xml").send(twiml.toString());
  }

  const otherPrompt = isCancellationSpeech(speech)
    ? OTHER_BOOKSY_LIMIT_PROMPT
    : OTHER_GENERAL_PROMPT;

  addSpeechGather(
    twiml,
    `${process.env.BASE_URL}/voice/collect-other?attempt=0`,
    otherPrompt
  );
  finishCall(twiml, "Nie usłyszałem treści zgłoszenia.");
  return res.type("text/xml").send(twiml.toString());
});

router.post("/faq", async (req, res) => {
  if (!validateTwilioRequest(req)) {
    return res.status(403).send("Forbidden");
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || "").trim();
  const turn = parseInt(req.query.turn || "1", 10);
  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid;

  if (speech && TRANSFER_KEYWORDS_REGEX.test(speech.toLowerCase())) {
    respondWithHumanCallbackPromise(twiml, { speech, from, to, callSid });
    return res.type("text/xml").send(twiml.toString());
  }

  if (!speech) {
    finishCallWithFeedbackPrompt(twiml);
    return res.type("text/xml").send(twiml.toString());
  }

  if (looksEnglish(speech)) {
    await respondInEnglish(twiml, { speech, from, to, callSid });
    return res.type("text/xml").send(twiml.toString());
  }

  // Ta trasa zawsze odpowiada na FAQ_FOLLOWUP_PROMPT ("Czy to wyczerpująca odpowiedź?").
  // Obieg wg Wiktorii, 16.09.2026: zadowolony albo milczy -> temat zamknięty; niezadowolony ->
  // Wiktoria oddzwania; cokolwiek innego -> traktujemy jak kolejne pytanie.
  const followup = classifyFaqFollowup(speech);

  if (followup === "zamknij") {
    finishCallWithFeedbackPrompt(twiml);
    return res.type("text/xml").send(twiml.toString());
  }

  if (followup === "oddzwon") {
    const internalPromise = sendOtherNotification({ callSid, from, to, speech });
    finishCallWithFeedbackPrompt(twiml, "W takim razie przekażę sprawę Wiktorii — oddzwoni i doradzi Ci najszybciej, jak to możliwe.");
    res.type("text/xml").send(twiml.toString());

    internalPromise.catch((err) => {
      console.error("FAQ followup notification error:", err.message || err);
      sendOpsAlert(`Nie udało się wysłać zgłoszenia (FAQ niewystarczające): ${err.message || err}`);
    });
    return;
  }

  const intent = await resolveIntent(speech);

  if (intent === "ZAPIS") {
    await respondWithBookingQuickLink(twiml, { speech, from, to, callSid });
    return res.type("text/xml").send(twiml.toString());
  }

  if (intent === "SPOZNIENIE") {
    addSpeechGather(
      twiml,
      `${process.env.BASE_URL}/voice/collect-late?attempt=0`,
      LATE_PROMPT
    );
    finishCall(twiml, "Nie usłyszałem, do którego salonu jesteś umówiony.");
    return res.type("text/xml").send(twiml.toString());
  }

  if (intent === "WSPOLPRACA") {
    addSpeechGather(twiml, `${process.env.BASE_URL}/voice/collect-cooperation?attempt=0`, COOPERATION_PROMPT);
    finishCall(twiml, "Nie usłyszałem, czego miałaby dotyczyć współpraca.");
    return res.type("text/xml").send(twiml.toString());
  }

  if (intent === "PYTANIE" && turn <= MAX_FAQ_TURNS) {
    await respondWithFaqAnswer(twiml, speech, turn + 1);
    return res.type("text/xml").send(twiml.toString());
  }

  const internalPromise = sendOtherNotification({ callSid, from, to, speech });
  finishCallWithFeedbackPrompt(twiml, "Przekażę to pytanie do Wiktorii — oddzwoni i doradzi Ci w tej sprawie najszybciej, jak to możliwe.");
  res.type("text/xml").send(twiml.toString());

  internalPromise.catch((err) => {
    console.error("FAQ overflow notification error:", err.message || err);
    sendOpsAlert(`Nie udało się wysłać zgłoszenia (FAQ→INNE): ${err.message || err}`);
  });
});

router.post("/booking-followup", async (req, res) => {
  if (!validateTwilioRequest(req)) {
    return res.status(403).send("Forbidden");
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || "").trim();
  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid;
  const locationName = req.query.location || "";
  const originalSpeech = req.query.originalSpeech || "";

  if (speech && TRANSFER_KEYWORDS_REGEX.test(speech.toLowerCase())) {
    respondWithHumanCallbackPromise(twiml, { speech, from, to, callSid });
    return res.type("text/xml").send(twiml.toString());
  }

  if (!speech) {
    // Cisza = klient nie chce dodatkowej pomocy telefonicznej, ma już link SMS-em.
    finishCallWithFeedbackPrompt(twiml);
    return res.type("text/xml").send(twiml.toString());
  }

  // Wcześniej KAŻDA wypowiedź po propozycji linku była traktowana jako prośba o telefon, więc
  // "Nie, dziękuję, wiem jak korzystać" kończyło się dopytywaniem o adres salonu i zgłoszeniem
  // do Wiktorii, o które klient wprost nie prosił. Ta sama klasa błędu co w trasach *-confirm
  // (przegląd 15.09.2026); odmowa ma kończyć rozmowę. Zgodne z diagramem Damiana i Wiktorii
  // z 16.09.2026, gdzie proszą wprost: "powiedz teraz TAK, a Wiktoria oddzwoni".
  if (isDeclinedAnswer(speech, GENERAL_DECLINE_REGEX)) {
    finishCallWithFeedbackPrompt(twiml);
    return res.type("text/xml").send(twiml.toString());
  }

  // Od Damiana, 18.09.2026: "może bot nie dopytywać o lokalizację [przy zapisie]?" — skoro
  // Wiktoria i tak oddzwania, sama dopyta o salon podczas rozmowy. Bot już nie zbiera adresu
  // głosowo w tej ścieżce (poprzednio /voice/collect-booking: dwuznaczne ulice, potwierdzanie,
  // AI-fallback — cała ta maszyneria stała się zbędna). Jeśli lokalizację udało się rozpoznać
  // z PIERWSZEJ wypowiedzi klienta (patrz respondWithBookingQuickLink), dorzucamy ją do
  // zgłoszenia jako bonus, bez pytania o nią ponownie.
  const locationMatch = (salonConfig.locations || []).find((l) => l.name === locationName) || null;
  const salonLabel = locationMatch ? formatLocationLabel(locationMatch) : "nie podano";
  // Dosłowna wypowiedź klienta z /voice/intent (nie ta odebrana tutaj — to tylko odpowiedź na
  // "powiedz TAK") — od Krzysztofa, 21.09.2026: zgłoszenie ZAPIS nie mówiło Wiktorii nic o tym,
  // co klient faktycznie powiedział na starcie rozmowy, więc oddzwaniała "w ciemno".
  const speechNote = originalSpeech ? ` Klient powiedział: "${originalSpeech}".` : "";
  const internalBody = `[ZAPIS] Klient ${from || "nieznany numer"} prosi o telefon w sprawie zapisu. Salon: ${salonLabel}.${speechNote}`;
  logCallback({ callSid, category: "ZAPIS", from, body: internalBody, keyBase: `${callSid}-zapis` });

  const internalPromise = notifyInternalRecipients({
    keyBase: `${callSid}-zapis`,
    recipients: getBookingInternalRecipients(),
    twilioCallTo: to,
    body: internalBody,
  });

  finishCallWithFeedbackPrompt(twiml, "Wiktoria oddzwoni i doradzi Ci w tej sprawie najszybciej, jak to możliwe.");
  res.type("text/xml").send(twiml.toString());

  internalPromise.catch((err) => {
    console.error("Booking notification error:", err.message || err);
    sendOpsAlert(`Nie udało się wysłać zgłoszenia ZAPIS: ${err.message || err}`);
  });
});

// Zgłoszenie spóźnienia rozbite na trzy krótkie kroki (po 1-2 informacje na raz) zamiast jednego
// dużego pytania o pięć rzeczy naraz — łatwiej to zrozumieć i łatwiej botowi to poprawnie rozpoznać.
// Wiktoria: przy spóźnieniu liczy się szybkość — klient dzwoni w pośpiechu. Pytamy WYŁĄCZNIE
// o salon (nawet nie o godzinę czy liczbę minut — te i tak są zwykle zaniżane i kosztują cenne
// sekundy). Imię ustali barber po numerze dzwoniącego. Ostrzeżenie o spóźnieniu mówimy na koniec,
// jako pożegnanie, nie na wstępie.
router.post("/collect-late", async (req, res) => {
  if (!validateTwilioRequest(req)) {
    return res.status(403).send("Forbidden");
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || "").trim();
  const attempt = parseInt(req.query.attempt || "0", 10);
  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid;

  if (speech && TRANSFER_KEYWORDS_REGEX.test(speech.toLowerCase())) {
    respondWithHumanCallbackPromise(twiml, { speech, from, to, callSid });
    return res.type("text/xml").send(twiml.toString());
  }

  if (!speech && attempt < MAX_NO_INPUT_RETRIES) {
    addSpeechGather(
      twiml,
      `${process.env.BASE_URL}/voice/collect-late?attempt=${attempt + 1}`,
      LATE_PROMPT
    );
    return res.type("text/xml").send(twiml.toString());
  }

  let { match: locationMatch, candidates } = speech
    ? findLocationMatchDeterministic(speech)
    : { match: null, candidates: [] };

  // Ta sama ekstrakcja AI co w /collect-booking (patrz komentarz tam) — działa tylko jako ostatnia
  // deska ratunku, gdy czysty regex nic nie znalazł, więc nie spowalnia typowego, szybkiego
  // przypadku (jasne wskazanie punktu orientacyjnego wciąż trafia od razu, bez wywołania AI).
  // Od klienta za pośrednictwem Wiktorii/Damiana, 11.09.2026: "słabo rozpoznaje lokalizacje na
  // podstawie charakterystycznych miejsc" — collect-late nie miało dotąd tego fallbacku wcale.
  if (!locationMatch && speech && candidates.length === 0) {
    try {
      const extracted = await extractLocationPhrase(speech);
      if (extracted) {
        const retryMatch = findLocationMatchDeterministic(extracted);
        locationMatch = retryMatch.match;
        candidates = retryMatch.candidates;
      }
    } catch (err) {
      console.error("Location extraction fallback error (collect-late):", err.message || err);
    }
  }

  // Ostatnia deska ratunku: prawdziwy punkt orientacyjny, którego po prostu nie ma w naszej
  // ręcznie prowadzonej liście (salon.js) — od Krzysztofa, 18.09.2026 ("bot często nie zna
  // punktów orientacyjnych Krakowa"). To NIE jest odrzucony wcześniej pomysł "AI zgaduje bez
  // sygnału" (patrz komentarz przy findLocationMatch) — sygnał tu jest, tylko nieznany bazie.
  // Bezpiecznik: cokolwiek stąd wróci, i tak przechodzi przez to samo obowiązkowe pytanie
  // o potwierdzenie co każdy inny match w tej trasie (kawałek niżej) — nigdy cichego trafienia.
  if (!locationMatch && speech && candidates.length === 0) {
    try {
      const matchedName = await matchLandmarkToSalon(speech, salonConfig.locations || []);
      if (matchedName) {
        locationMatch = (salonConfig.locations || []).find((l) => l.name === matchedName) || null;
      }
    } catch (err) {
      console.error("AI landmark fallback error (collect-late):", err.message || err);
    }
  }

  if (!locationMatch && speech && attempt < MAX_NO_INPUT_RETRIES) {
    // Mamy kilku kandydatów (np. "na Krowodrzy") — wymieniamy je i prosimy o wybór.
    // Nie mamy żadnego — zawężamy obszarami zamiast prosić o ten sam adres jeszcze raz.
    let prompt;
    if (candidates.length > 0) prompt = describeLocationOptions(candidates);
    else if (attempt === 0) prompt = LATE_AREA_PROMPT;
    else prompt = LATE_AREA_RETRY_PROMPT;

    addSpeechGather(twiml, `${process.env.BASE_URL}/voice/collect-late?attempt=${attempt + 1}`, prompt);
    return res.type("text/xml").send(twiml.toString());
  }

  if (!locationMatch) {
    // Dołączamy dosłowną wypowiedź klienta — od Krzysztofa, 21.09.2026: gdy bot nie ustalił
    // salonu, zgłoszenie mówiło Wiktorii tylko "nie ustalono", bez tego, co klient w ogóle mówił,
    // mimo że ta wypowiedź jest tu cały czas dostępna. Bez niej Wiktoria oddzwaniała, nie
    // wiedząc nawet, co klient próbował przekazać o swojej lokalizacji.
    const speechNote = speech ? ` Klient powiedział: "${speech}".` : "";
    const body = `[SPÓŹNIENIE] Salon: nie ustalono; Kontakt: ${from || "nieznany numer"}.${speechNote}`;
    logCallback({ callSid, category: "SPÓŹNIENIE", from, body, keyBase: `${callSid}-spoznienie` });

    const internalPromise = notifyInternalRecipients({
      keyBase: `${callSid}-spoznienie`,
      recipients: getLateRecipients(null),
      twilioCallTo: to,
      body,
    });

    finishCallWithFeedbackPrompt(
      twiml,
      "Nie udało mi się ustalić, do którego salonu jesteś umówiony, ale przekazuję sprawę do konsultanta. Wiktoria oddzwoni najszybciej, jak to możliwe."
    );
    res.type("text/xml").send(twiml.toString());

    internalPromise.catch((err) => {
      console.error("Late notification error:", err.message || err);
      sendOpsAlert(`Nie udało się wysłać zgłoszenia SPÓŹNIENIE: ${err.message || err}`);
    });
    return;
  }

  // Klient może się pomylić albo bot może źle zrozumieć — potwierdzamy salon przed wysyłką.
  if (locationMatch) {
    const params = new URLSearchParams({ location: locationMatch.name, speech });
    addSpeechGather(
      twiml,
      `${process.env.BASE_URL}/voice/collect-late-confirm?${params.toString()}`,
      `Zrozumiałem, że chodzi o salon ${locationNameForSpeech(locationMatch)}. Czy potwierdzasz?`
    );
    finishCall(twiml, "Nie udało się dokończyć zgłoszenia.");
    return res.type("text/xml").send(twiml.toString());
  }

  await finalizeLateNotification(twiml, { locationMatch, originalSpeech: speech, from, to, callSid });
  return res.type("text/xml").send(twiml.toString());
});

router.post("/collect-late-confirm", async (req, res) => {
  if (!validateTwilioRequest(req)) {
    return res.status(403).send("Forbidden");
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const answer = (req.body.SpeechResult || "").trim().toLowerCase();
  const locationName = req.query.location || "";
  const originalSpeech = req.query.speech || "";
  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid;

  // Cisza traktujemy jak potwierdzenie (lepiej zgłosić na podstawie sensownej podpowiedzi niż
  // zgubić całe zgłoszenie) — odrzucamy tylko przy wyraźnym zaprzeczeniu.
  const declined = isDeclinedAnswer(answer, /(zły salon|zła lokalizacj|inny salon|pomyliłe)/i);

  if (declined) {
    addSpeechGather(
      twiml,
      `${process.env.BASE_URL}/voice/collect-late?attempt=1`,
      "Przepraszam, powiedz proszę dokładną nazwę ulicy salonu."
    );
    return res.type("text/xml").send(twiml.toString());
  }

  const locationMatch = (salonConfig.locations || []).find((l) => l.name === locationName) || null;
  await finalizeLateNotification(twiml, { locationMatch, originalSpeech, from, to, callSid });
  return res.type("text/xml").send(twiml.toString());
});

// Nawet gdy salon się nie ustalił (cisza albo wyczerpane próby), i tak zgłaszamy —
// lepszy niepełny alarm niż zignorowany klient, na którego czeka barber.
// Imienia barbera celowo NIE dopytujemy osobno (to wydłużałoby rozmowę) — jeśli klient
// sam je poda przy okazji ("do Pawła"), to bonus, który dorzucamy do zgłoszenia.
async function finalizeLateNotification(twiml, { locationMatch, originalSpeech, from, to, callSid }) {
  const barberName = originalSpeech ? sanitizeNameField(extractBarberName(originalSpeech)) : null;
  const recipients = getLateRecipients(locationMatch);
  const barberNote = barberName ? ` Barber: ${barberName};` : "";
  // Dosłowna wypowiedź klienta w zgłoszeniu — od Krzysztofa, 21.09.2026: przydatna zwłaszcza gdy
  // salon ustalił się dopiero po kilku próbach (candidates/AI fallback) — Wiktoria widzi, co
  // klient naprawdę powiedział, zamiast tylko końcowego wyniku dopasowania.
  const speechNote = originalSpeech ? ` Klient powiedział: "${originalSpeech}".` : "";
  const body = `[SPÓŹNIENIE] Salon: ${locationMatch ? formatLocationLabel(locationMatch) : "nie podano"};${barberNote} Kontakt: ${from || "nieznany numer"}.${speechNote}`;
  logCallback({ callSid, category: "SPÓŹNIENIE", from, body, keyBase: `${callSid}-spoznienie` });

  const internalPromise = notifyInternalRecipients({
    keyBase: `${callSid}-spoznienie`,
    recipients,
    twilioCallTo: to,
    body,
  });

  // Krótkie potwierdzenie od razu po rozpoznaniu zgłoszenia, zanim padnie ostrzeżenie — od klienta
  // za pośrednictwem Wiktorii/Damiana, 11.09.2026 ("bot powinien krótko potwierdzić: Rozumiem,
  // przekazuję informację o spóźnieniu do salonu").
  sayPl(twiml, LATE_CONFIRMATION);
  sayPl(twiml, LATE_WARNING);
  twiml.hangup();

  internalPromise.catch((err) => {
    console.error("Late notification error:", err.message || err);
    sendOpsAlert(`Nie udało się wysłać zgłoszenia SPÓŹNIENIE: ${err.message || err}`);
  });
}

router.post("/collect-other", async (req, res) => {
  if (!validateTwilioRequest(req)) {
    return res.status(403).send("Forbidden");
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || "").trim();
  const attempt = parseInt(req.query.attempt || "0", 10);
  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid;

  if (!speech) {
    if (attempt < MAX_NO_INPUT_RETRIES) {
      addSpeechGather(
        twiml,
        `${process.env.BASE_URL}/voice/collect-other?attempt=${attempt + 1}`,
        "Nie dosłyszałem treści zgłoszenia. Powiedz proszę krótko, w jakiej sprawie dzwonisz."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    finishCallWithFeedbackPrompt(twiml, "Nie udało się nagrać zgłoszenia.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Uwaga: celowo BEZ sprawdzania TRANSFER_KEYWORDS_REGEX tutaj — to jest wolna, opisowa treść
  // zgłoszenia klienta, gdzie słowa typu "konsultant"/"pracownik" mogą naturalnie paść jako część
  // opisu sprawy (np. reklamacji), a nie jako prośba o przełączenie. Zbieranie tematu przez tę
  // ścieżkę i tak prowadzi do oddzwonienia, więc efekt dla klienta jest zbliżony.

  // Klient opisujący sprawę (zwłaszcza odwołanie/zmianę wizyty) często sam podaje przy okazji
  // nazwę salonu — jeśli ją jednoznacznie złapaliśmy, powtarzamy w pytaniu o potwierdzenie, żeby
  // można się było poprawić, zanim zgłoszenie pójdzie do Wiktorii. Od Damiana, 17.09.2026: "może
  // bot jeszcze powtórzyć czy dobrze wyłapał salon... żeby jeśli ktoś się pomyli, mógł się
  // poprawić". Celowo tylko przy JEDNOZNACZNYM dopasowaniu (nie przy kilku kandydatach) — przy
  // niejednoznaczności dogadywanie się o to w jednym zdaniu obok reszty zgłoszenia tylko by je
  // zagmatwało, a Wiktoria i tak dostaje pełny, nietknięty opis klienta.
  const { match: detectedLocation } = findLocationMatchDeterministic(speech);
  const confirmQuestion = detectedLocation
    ? `Zrozumiałem, że chodzi o salon ${locationNameForSpeech(detectedLocation)}. Czy mam przekazać to zgłoszenie Wiktorii, żeby oddzwoniła?`
    : "Czy mam przekazać to zgłoszenie Wiktorii, żeby oddzwoniła?";

  addSpeechGather(
    twiml,
    `${process.env.BASE_URL}/voice/confirm-other?speech=${encodeURIComponent(speech)}`,
    confirmQuestion
  );
  finishCall(twiml);
  return res.type("text/xml").send(twiml.toString());
});

router.post("/confirm-other", async (req, res) => {
  if (!validateTwilioRequest(req)) {
    return res.status(403).send("Forbidden");
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const answer = (req.body.SpeechResult || "").trim().toLowerCase();
  const speech = decodeURIComponent(req.query.speech || "");
  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid;

  const declined = isDeclinedAnswer(answer, /(nieważne|anuluj|zrezygnuj|daj spokój|zostaw)/i);

  if (declined || !speech) {
    finishCallWithFeedbackPrompt(twiml, "Dobrze, nie przekazuję.");
    return res.type("text/xml").send(twiml.toString());
  }

  const internalPromise = sendOtherNotification({ callSid, from, to, speech });

  finishCallWithFeedbackPrompt(twiml, "Wiktoria oddzwoni do Ciebie i doradzi w tej sprawie najszybciej, jak to możliwe.");
  res.type("text/xml").send(twiml.toString());

  internalPromise.catch((err) => {
    console.error("Other notification error:", err.message || err);
    sendOpsAlert(`Nie udało się wysłać zgłoszenia INNE: ${err.message || err}`);
  });
});

// Telefon o współpracy (patrz COOPERATION_REGEX) — jeden krok, bez pytania o potwierdzenie:
// niższa stawka niż przy zgłoszeniu klienta (nikt niczego nie czeka), a Wiktoria opisała to jako
// coś, co ma tylko przefiltrować, więc dodatkowe pytanie tylko wydłużałoby rozmowę bez potrzeby.
router.post("/collect-cooperation", async (req, res) => {
  if (!validateTwilioRequest(req)) {
    return res.status(403).send("Forbidden");
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || "").trim();
  const attempt = parseInt(req.query.attempt || "0", 10);
  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid;

  if (!speech) {
    if (attempt < MAX_NO_INPUT_RETRIES) {
      addSpeechGather(
        twiml,
        `${process.env.BASE_URL}/voice/collect-cooperation?attempt=${attempt + 1}`,
        COOPERATION_NO_INPUT_PROMPT
      );
      return res.type("text/xml").send(twiml.toString());
    }

    finishCall(twiml, "Nie udało się zebrać szczegółów współpracy.");
    return res.type("text/xml").send(twiml.toString());
  }

  const internalPromise = sendCooperationNotification({ callSid, from, to, speech });

  // Bez obietnicy oddzwonienia — patrz komentarz przy COOPERATION_PROMPT.
  finishCallWithFeedbackPrompt(twiml, "Dziękuję, przekazuję tę informację do zespołu.");
  res.type("text/xml").send(twiml.toString());

  internalPromise.catch((err) => {
    console.error("Cooperation notification error:", err.message || err);
    sendOpsAlert(`Nie udało się wysłać zgłoszenia WSPÓŁPRACA: ${err.message || err}`);
  });
});

// Odbiór uwagi o działaniu bota, zebranej przez finishCallWithFeedbackPrompt.
router.post("/feedback", async (req, res) => {
  if (!validateTwilioRequest(req)) {
    return res.status(403).send("Forbidden");
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || "").trim();
  const attempt = parseInt(req.query.attempt || "0", 10);
  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid;

  const wordCount = speech ? speech.trim().split(/\s+/).length : 0;
  if (speech && wordCount <= SHORT_AFFIRMATION_MAX_WORDS && SHORT_AFFIRMATION_REGEX.test(speech.toLowerCase()) && attempt < 1) {
    addSpeechGather(
      twiml,
      `${process.env.BASE_URL}/voice/feedback?attempt=1`,
      "Słucham, jakie to uwagi?"
    );
    return res.type("text/xml").send(twiml.toString());
  }

  if (speech) {
    const internalPromise = notifyInternalRecipients({
      keyBase: `${callSid}-feedback`,
      recipients: getBookingInternalRecipients(),
      twilioCallTo: to,
      body: `[UWAGA O BOCIE] Klient ${from || "nieznany numer"}: ${speech}`,
    });
    internalPromise.catch((err) => {
      console.error("Feedback notification error:", err.message || err);
      sendOpsAlert(`Nie udało się wysłać uwagi o bocie: ${err.message || err}`);
    });

    // Potwierdzenie, że uwaga faktycznie gdzieś trafia — od Krzysztofa, 21.09.2026: bot zbierał
    // uwagę i po prostu się żegnał, bez ani słowa o tym, co się z nią dalej dzieje.
    finishCall(twiml, "Dziękuję, przekazuję Twoją uwagę dalej, żeby usprawnić działanie bota.");
    return res.type("text/xml").send(twiml.toString());
  }

  finishCall(twiml);
  return res.type("text/xml").send(twiml.toString());
});

function sendOtherNotification({ callSid, from, to, speech }) {
  const body = `[INNE] Klient ${from || "nieznany numer"}: ${speech}`;
  logCallback({ callSid, category: "INNE", from, body, keyBase: `${callSid}-inne` });

  return notifyInternalRecipients({
    keyBase: `${callSid}-inne`,
    recipients: getBookingInternalRecipients(),
    twilioCallTo: to,
    body,
  });
}

// Celowo BEZ logCallback: /admin/callbacks to lista "klient czeka na telefon", a tu nikt na nic
// nie czeka — bot niczego nie obiecał (patrz COOPERATION_PROMPT). Sama wysyłka do zespołu
// wystarczy, żeby Wiktoria/Damian mogli sami zdecydować, czy odpowiedzieć.
function sendCooperationNotification({ callSid, from, to, speech }) {
  const body = `[WSPÓŁPRACA] Od ${from || "nieznany numer"}: ${speech}`;

  return notifyInternalRecipients({
    keyBase: `${callSid}-wspolpraca`,
    recipients: getBookingInternalRecipients(),
    twilioCallTo: to,
    body,
  });
}

// Najczęstsze pytania (godziny, ceny, vouchery, liczba salonów) odpowiadamy z konfiguracji,
// bez sięgania do OpenAI — to oszczędza ~0,8-2,2 s ciszy w rozmowie (pomiar 15.09.2026).
// answerFaqDeterministic zwraca null przy każdej wątpliwości, więc reszta leci do AI jak dotąd.
async function getFaqAnswer(speech, errorContext) {
  const instantAnswer = answerFaqDeterministic(speech);
  if (instantAnswer) return instantAnswer;

  try {
    return await getAIResponse(speech);
  } catch (err) {
    console.error(`AI response error (${errorContext}):`, err.message || err);
    return FAQ_FALLBACK_ANSWER;
  }
}

async function respondWithFaqAnswer(twiml, speech, nextTurn) {
  const answer = await getFaqAnswer(speech, "FAQ");

  if (nextTurn > MAX_FAQ_TURNS) {
    finishCallWithFeedbackPrompt(twiml, answer);
    return;
  }

  sayPl(twiml, answer);
  addSpeechGather(
    twiml,
    `${process.env.BASE_URL}/voice/faq?turn=${nextTurn}`,
    FAQ_FOLLOWUP_PROMPT
  );
  finishCall(twiml);
}

// Domyślna ścieżka ZAPIS: od razu wysyłamy link do rezerwacji (do konkretnego salonu, jeśli go
// rozpoznaliśmy) i pytamy, czy klient chce dodatkowo telefonicznej pomocy — zamiast za każdym razem
// zbierać pełne dane głosowo i generować telefon do Wiktorii, nawet gdy klient i tak woli zapisać się sam.
async function respondWithBookingQuickLink(twiml, { speech, from, to, callSid }) {
  const locationMatch = await findLocationMatch(speech);

  const smsPromise = sendClientBooksySms({
    key: `${callSid}-zapis-link`,
    to: from,
    twilioFrom: to,
    location: locationMatch,
  });
  smsPromise.catch((err) => {
    console.error("Booksy link SMS error:", err.message || err);
    sendOpsAlert(`Nie udało się wysłać linku Booksy: ${err.message || err}`);
  });

  // Treść wg Damiana, 18.09.2026 — świadomie BEZ tłumaczenia "ze względu na ograniczenia Booksy":
  // przy nowym zapisie bot niczego nie odmawia, tylko oferuje dwie równorzędne opcje (link albo
  // telefon), więc usprawiedliwianie się byłoby zbędne. To tłumaczenie zostaje tam, gdzie bot
  // faktycznie odmawia konkretnej prośbie (patrz OTHER_BOOKSY_LIMIT_PROMPT przy odwołaniu wizyty).
  // "SMS z linkiem" zamiast "SMS-em link" — od Krzysztofa, 21.09.2026: przy żywym telefonie
  // poprzednie sformułowanie brzmiało nieskładnie.
  const salonNote = locationMatch ? ` w salonie ${locationNameForSpeech(locationMatch)}` : "";
  const bookingIntro = willSendBooksySms(from)
    ? `Wysyłam Ci SMS z linkiem do rezerwacji w Booksy${salonNote}, gdzie znajdziesz wszystkie dostępne terminy.`
    : `Zarezerwujesz samodzielnie przez aplikację Booksy${salonNote}, gdzie znajdziesz wszystkie dostępne terminy.`;

  // Lokalizacja rozpoznana z PIERWSZEJ wypowiedzi klienta (jeśli się udało) leci dalej w query
  // stringu — /voice/booking-followup już o nic nie dopytuje, więc to jedyna szansa, żeby
  // zgłoszenie do Wiktorii zawierało salon, bez zadawania drugiego pytania.
  // Oryginalna wypowiedź klienta leci tym samym mechanizmem — od Krzysztofa, 21.09.2026: Wiktoria
  // dostawała samo "prosi o telefon w sprawie zapisu", bez tego, co klient faktycznie powiedział
  // na starcie rozmowy ("żeby zerkała na to, co klient tam nawymyślał").
  const followupParams = new URLSearchParams({ attempt: "0" });
  if (locationMatch) followupParams.set("location", locationMatch.name);
  if (speech) followupParams.set("originalSpeech", speech);

  // Instrukcja "powiedz TAK" wyodrębniona do krótkiego, samodzielnego zdania na końcu — od
  // Krzysztofa, 21.09.2026: poprzednia wersja ("Jeśli jednak wolisz, żeby Wiktoria pomogła Ci
  // telefonicznie, powiedz „TAK” — oddzwoni najszybciej, jak to możliwe.") chowała instrukcję w
  // środku długiego zdania podrzędnego i klienci na żywo jej nie łapali. Brzmienie bliższe
  // pierwotnemu diagramowi Damiana i Wiktorii (16.09.2026): "powiedz teraz TAK, a Wiktoria oddzwoni".
  addSpeechGather(
    twiml,
    `${process.env.BASE_URL}/voice/booking-followup?${followupParams.toString()}`,
    `${bookingIntro} Powiedz teraz „TAK”, jeśli zamiast tego wolisz, żeby oddzwoniła do Ciebie Wiktoria.`
  );
  finishCall(twiml, "Nie udało się dokończyć zgłoszenia.");
}

function validateTwilioRequest(req) {
  if (process.env.NODE_ENV === "development") return true;

  const twilioSignature = req.headers["x-twilio-signature"];
  const url = `${process.env.BASE_URL}${req.originalUrl}`;
  // Żądanie bez treści albo z nieznanym Content-Type zostawia req.body jako undefined (Express 5),
  // a SDK Twilio robi na tym Object.keys i rzuca TypeError. Efekt: zamiast czystego 403 leciał
  // wyjątek, łapała go siatka bezpieczeństwa w index.js i odsyłała TwiML ze statusem 200 — czyli
  // byle skaner dostawał "OK" i stack trace w logach. Zaobserwowane na produkcji 15.09.2026.
  const params = req.body || {};
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  return twilio.validateRequest(authToken, twilioSignature, url, params);
}

// "hut" (zamiast pełnego "nowa huta") łapie też potoczne "Huta"/"w Hucie" — tak Krakowianie
// niemal zawsze mówią o tej dzielnicy, patrz DISTRICT_KEYWORDS niżej.
const FAQ_KEYWORDS_REGEX =
  /(cena|cennik|kosztuje|koszt |godzin|otwarte|otwarci|czynne|nieczynne|adres|lokalizacj|gdzie|salon|parking|dojazd|usług|uslug|ofert|produkt|kosmetyk|opini|ocena|atmosfer|hut|krowodrza|dębnik|debnik|mistrzejowice|podwawelsk|voucher|bon podarunkow|bony podarunkow|prezent)/i;

// Klienci rzadko mówią wprost "spóźnię się" — częściej opisują objaw (korek, coś wypadło, awaria
// auta, "nie zdążę na czas"). Bez tego "umówiłem się wcześniej, ale coś mi wypadło i nie zdążę na
// czas" łapało się na rdzeń "umówi" niżej i mylnie leciało do ZAPIS, zanim w ogóle dotarło do
// fallbacku AI (fallback AI działa tylko, gdy TA funkcja zwróci "INNE" — zob. resolveIntent).
// Znalezione na testach 05.09.2026 po zgłoszeniu Wiktorii o niewyłapywaniu nieskładnej mowy.
const LATE_SIGNAL_REGEX =
  /(p[oó]źn|nie zdąż|w korku|utkną|coś (mi |nam )?wypadł|popsuł|awari|z op[oó]źnieniem)/i;

function detectIntent(speech) {
  const s = (speech || "").toLowerCase();
  // Rozpoznawanie mowy potrafi urwać "s" z początku ("spóźnię się" -> "późniejsze") — dlatego
  // łapiemy sam rdzeń "późn" (z ó, bo to jedyna litera odróżniająca to od "Poznań"/"poznańska"),
  // a nie tylko warianty zaczynające się od "sp"/"op".
  if (LATE_SIGNAL_REGEX.test(s)) return "SPOZNIENIE";
  // Sprawdzane PRZED regexem ZAPIS: "zmienić termin"/"odwołać wizytę" zawiera "termin", więc bez
  // tego łapało się na ZAPIS i rozmówca proszący o odwołanie dostawał ofertę zapisu na nową wizytę.
  if (CANCELLATION_REGEX.test(s)) return "INNE";
  if (COOPERATION_REGEX.test(s)) return "WSPOLPRACA";
  if (/(um[oó]wi|zapis|rezerw|booksy|buksi|termin)/i.test(s)) return "ZAPIS";
  if (FAQ_KEYWORDS_REGEX.test(s)) return "PYTANIE";
  return "INNE";
}

function isCancellationSpeech(speech) {
  return CANCELLATION_REGEX.test((speech || "").toLowerCase());
}

// Klienci często mówią nieskładnie, od tyłu albo tłumaczą się zanim dojdą do sedna (zgłoszone
// przez Wiktorię, 05.09.2026) — sam regex słów kluczowych tego nie złapie. Dopóki dopasowanie
// jest jednoznaczne (nie INNE), ufamy szybkiej ścieżce bez AI; dopiero gdy regex nic nie złapał,
// dopytujemy model o klasyfikację całej wypowiedzi, zanim uznamy sprawę za "inną".
async function resolveIntent(speech) {
  const s = (speech || "").toLowerCase();
  // Odwołanie/zmiana wizyty to PEWNE "INNE" — ani nie trzeba pytać AI (koszt/opóźnienie bez
  // potrzeby), ani nie wolno pozwolić AI to przypadkiem nadpisać (np. błędnie na ZAPIS).
  // Sprawdzane tu, a nie tylko w detectIntent, bo detectIntent i tak zwraca "INNE" jako wynik
  // domyślny przy braku sygnału — bez tego rozróżnienia nie dało się odróżnić "pewne INNE" od
  // "brak sygnału, zapytajmy AI" i AI było odpytywane bez potrzeby przy każdym odwołaniu.
  if (CANCELLATION_REGEX.test(s)) return "INNE";

  const quickIntent = detectIntent(speech);
  if (quickIntent !== "INNE") return quickIntent;

  // Jeśli umiemy odpowiedzieć na to z samej konfiguracji, to z definicji jest to PYTANIE — nie ma
  // po co pytać AI o klasyfikację. Łapie sformułowania spoza FAQ_KEYWORDS_REGEX ("o której
  // zamykacie w soboty"), które wcześniej kosztowały ~0,6-0,9 s na samo rozpoznanie intencji,
  // mimo że odpowiedź i tak powstawała potem natychmiast. Pomiar 15.09.2026.
  if (answerFaqDeterministic(speech)) return "PYTANIE";

  try {
    return await classifyIntent(speech);
  } catch (err) {
    console.error("Intent AI classification fallback error:", err.message || err);
    return "INNE";
  }
}

// Rozpoznawanie mowy jest ustawione na polski (pl-PL) — Twilio nie umie automatycznie wykrywać
// języka w jednym Gather. To, co dostajemy dla mowy angielskiej, bywa zniekształcone, ale typowe
// angielskie słowa/zwroty zwykle i tak przechodzą przez rozpoznawanie w rozpoznawalnej formie.
const ENGLISH_HINT_REGEX =
  /\b(hello|hi there|hey|good morning|good afternoon|good evening|i would like|i want to|can i|could i|do you speak english|speak english|no polish|don'?t speak polish|book an appointment|make an appointment|appointment|what time|opening hours|how much (is|does)|price list|haircut|beard trim|thank you)\b/i;

function looksEnglish(speech) {
  return ENGLISH_HINT_REGEX.test(speech || "");
}

const ENGLISH_CALLBACK_MESSAGE =
  "Thank you for calling Kruk Barbershop! It looks like you would prefer English. Someone from our team will call you back as soon as possible. Thank you for your patience!";

async function respondInEnglish(twiml, { speech, from, to, callSid }) {
  const body = `[EN] English-speaking caller ${from || "unknown number"}: "${speech}". Please call back in English.`;
  logCallback({ callSid, category: "EN", from, body, keyBase: `${callSid}-en` });

  const internalPromise = notifyInternalRecipients({
    keyBase: `${callSid}-en`,
    recipients: getBookingInternalRecipients(),
    twilioCallTo: to,
    body,
  });

  twiml.say({ voice: ENGLISH_VOICE, language: "en-US" }, ENGLISH_CALLBACK_MESSAGE);
  twiml.hangup();

  internalPromise.catch((err) => {
    console.error("English caller notification error:", err.message || err);
    sendOpsAlert(`Nie udało się wysłać zgłoszenia [EN]: ${err.message || err}`);
  });
}

async function respondWithLanguageBarrierFallback(twiml, { from, to, callSid }) {
  const body = `[JĘZYK?] Nie udało się zrozumieć dzwoniącego ${from || "nieznany numer"} po polsku (możliwa bariera językowa) — oddzwoń.`;
  logCallback({ callSid, category: "JĘZYK?", from, body, keyBase: `${callSid}-lang-barrier` });

  const internalPromise = notifyInternalRecipients({
    keyBase: `${callSid}-lang-barrier`,
    recipients: getBookingInternalRecipients(),
    twilioCallTo: to,
    body,
  });

  sayPl(twiml, "Nie udało mi się zrozumieć. Przekażę to zespołowi, ktoś oddzwoni.");
  twiml.say(
    { voice: ENGLISH_VOICE, language: "en-US" },
    "Sorry, I could not understand. Someone from our team will call you back shortly."
  );
  twiml.hangup();

  internalPromise.catch((err) => {
    console.error("Language barrier notification error:", err.message || err);
    sendOpsAlert(`Nie udało się wysłać zgłoszenia [JĘZYK?]: ${err.message || err}`);
  });
}

// Odmiana przez przypadki dla nazw dzielnic, w których jest więcej niż jeden salon — potrzebna,
// żeby wykryć niejednoznaczność ("na Krowodrzy", "w Nowej Hucie"), a nie tylko formę słownikową.
// Krakowianie prawie zawsze mówią po prostu "Huta"/"w Hucie", bez "Nowa/Nowej" — zgłoszone przez
// Wiktorię 08.09.2026: bez samego rdzenia "hut" bot w ogóle nie łapał tej dzielnicy w tej, zdecydowanie
// najczęstszej, potocznej formie i nie proponował żadnych salonów.
const DISTRICT_KEYWORDS = [
  { stem: "krowodrz", districtContains: "krowodrz" },
  { stem: "dębnik", districtContains: "dębnik" },
  { stem: "debnik", districtContains: "dębnik" },
  { stem: "podwawelsk", districtContains: "podwawelsk" },
  // "Centrum" wskazuje na WSZYSTKIE salony z Krowodrzy (Wrocławska 60 i 5A, Urzędnicza 48,
  // Prądnicka 77), nie tylko te dwa, których pole "district" dosłownie zawiera "centrum"/"Stare
  // Miasto" — zgłoszone przez Damiana 17.09.2026: mówiąc "w centrum" (dokładnie tak, jak
  // podpowiada LATE_AREA_PROMPT), dostawał tylko Wrocławską 60 i Urzędniczą, bez Wrocławskiej 5A
  // i Prądnickiej, mimo że wszystkie cztery leżą w tej samej, centralnej części Krakowa. Zamiast
  // zgadywać dokładną granicę "centrum" kontra "Krowodrza" (rozróżnienie, którego przeciętny
  // dzwoniący i tak nie zna), traktujemy je jako jeden klaster — kończy się listą do wyboru,
  // a nie cichym trafieniem w jeden z nich.
  { stem: "centrum", districtContains: "krowodrz" },
  { stem: "śródmieś", districtContains: "krowodrz" },
  { stem: "srodmieś", districtContains: "krowodrz" },
  { stem: "stare miasto", districtContains: "stare miasto" },
  { stem: "starym mieście", districtContains: "stare miasto" },
  // Rdzeń "starów", nie "starówk" — pada też "na starówce", a nie tylko "starówka".
  { stem: "starów", districtContains: "stare miasto" },
  { stem: "starow", districtContains: "stare miasto" },
  { stem: "mistrzejowic", districtContains: "mistrzejowic" },
  { stem: "nowa huta", districtContains: "nowa huta" },
  { stem: "nowej hucie", districtContains: "nowa huta" },
  { stem: "nowej huty", districtContains: "nowa huta" },
  { stem: "nową hutą", districtContains: "nowa huta" },
  { stem: "hucie", districtContains: "nowa huta" },
  { stem: "huty", districtContains: "nowa huta" },
  { stem: "hutą", districtContains: "nowa huta" },
  { stem: "hutę", districtContains: "nowa huta" }, // biernik: "chodzi mi o Nową Hutę"
  { stem: "huta", districtContains: "nowa huta" },
];

// --- Dopasowanie odporne na polską odmianę ---------------------------------------------------
// Landmarki były dotąd porównywane gołym s.includes(), czyli łapały WYŁĄCZNIE tę formę, która jest
// dosłownie wpisana w salon.js. Skutek, znaleziony 21.09.2026 (Krzysztof): bot sam czytał klientowi
// podpowiedź "koło Multikina i Serenady" (landmarkSummary), a gdy klient powtarzał "koło Serenady",
// nie rozpoznawał własnych słów — bo w konfiguracji jest mianownik "Serenada". Tak samo "koło Błoń",
// "przy Tauron Arenie". Ręczne dopisywanie odmian (próba z tego samego dnia, ~30 wpisów) nie
// skaluje się: zawsze zostaje forma, o której nikt nie pomyślał, a konfiguracja puchnie.
//
// Zamiast tego porównujemy SŁOWAMI: wypowiedź i wpis z konfiguracji tniemy na słowa, zdejmujemy
// polskie znaki i uznajemy dwa słowa za tę samą formę, jeśli różnią się wyłącznie końcówką.
const POLISH_DIACRITICS = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };

function foldPolish(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => POLISH_DIACRITICS[ch]);
}

function tokenizeForMatch(text) {
  return foldPolish(text).split(/[^a-z0-9]+/).filter(Boolean);
}

// Krótkie słowa muszą zgadzać się DOKŁADNIE — "Lea", "AGH", "M1", "NCK", "5a" nie mają końcówki
// fleksyjnej, którą dałoby się bezpiecznie obciąć, a przy 2-3 znakach każde poluzowanie zaczyna
// łapać przypadkowe słowa z wypowiedzi.
const MIN_FUZZY_WORD_LEN = 4;
// ...ale we frazie WIELOWYRAZOWEJ pozostałe słowa same w sobie są kontekstem, więc krótkie słowo
// może się tam odmieniać bezpiecznie ("Nowy Kleparz" -> "koło Nowego Kleparza"). Zmierzone
// 21.09.2026: przy globalnym progu 3 spójnik "ale" zbliżał się do "Aleja" — a we frazie "Aleja Róż"
// nadal nic nie łapie, bo musi po nim paść jeszcze "Róż".
const MIN_FUZZY_WORD_LEN_IN_PHRASE = 3;
// Polska odmiana zmienia zwykle 1-3 znaki na końcu ("Serenada"/"Serenady", "Plac"/"Placu",
// "Krakowski"/"Krakowskiego"). Większa różnica to już inne słowo, nie inny przypadek.
const MAX_INFLECTION_DIFF = 3;

function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

// Czy to dwie formy tego samego słowa? Rdzeń (wspólny początek) musi zostać nietknięty, a różnica
// może być TYLKO na końcu i to po obu stronach — dzięki temu "arce" nie skleja się z "arka"
// (rozjazd już na 3. znaku), a "serenada" ze "serenady" tak.
function wordFormsMatch(speechWord, configWord, minLen = MIN_FUZZY_WORD_LEN) {
  if (speechWord === configWord) return true;

  const shorter = Math.min(speechWord.length, configWord.length);
  if (shorter < minLen) return false;

  const prefix = commonPrefixLength(speechWord, configWord);
  if (prefix < minLen) return false;

  return (
    speechWord.length - prefix <= MAX_INFLECTION_DIFF && configWord.length - prefix <= MAX_INFLECTION_DIFF
  );
}

// Czy wypowiedź zawiera daną frazę jako ciąg kolejnych słów (każde może być odmienione)?
// Wieloczłonowe wpisy ("Plac Bieńczycki") wymagają WSZYSTKICH słów po kolei, więc są z natury
// bezpieczniejsze od jednoczłonowych — samo "Prądnicka" nie wystarczy, żeby trafić w "Prądnik Czerwony".
function speechContainsPhrase(speechTokens, phraseTokens, { fuzzy }) {
  if (phraseTokens.length === 0 || phraseTokens.length > speechTokens.length) return false;

  const minLen = phraseTokens.length > 1 ? MIN_FUZZY_WORD_LEN_IN_PHRASE : MIN_FUZZY_WORD_LEN;
  const wordsEqual = fuzzy ? (a, b) => wordFormsMatch(a, b, minLen) : (a, b) => a === b;

  for (let start = 0; start + phraseTokens.length <= speechTokens.length; start += 1) {
    let matchesHere = true;
    for (let offset = 0; offset < phraseTokens.length; offset += 1) {
      if (!wordsEqual(speechTokens[start + offset], phraseTokens[offset])) {
        matchesHere = false;
        break;
      }
    }
    if (matchesHere) return true;
  }

  return false;
}

// Formy, po których salon rozpoznajemy PEWNIE (bez pytania o potwierdzenie): pełna nazwa, aliasy
// i — od 21.09.2026 — speechName, czyli dokładnie to brzmienie, którym bot sam się posługuje.
// Bez speechName bot wymieniał opcje "...albo Wrocławska pięć A", klient powtarzał to słowo w słowo,
// a bot nie miał tego nigdzie w konfiguracji (były tylko formy z cyfrą: "wroclawska 5a") i pytał
// w kółko o to samo. Wyliczamy to z konfiguracji, żeby nowy salon nie mógł przywrócić tej pętli.
function preciseFormsOf(location) {
  return [location.name, ...(location.aliases || []), location.speechName]
    .filter(Boolean)
    .map((form) => tokenizeForMatch(form))
    .filter((tokens) => tokens.length > 0);
}

// Słowa, które odróżniają JEDEN salon od pozostałych kandydatów — w praktyce numer budynku,
// słownie albo cyfrą ("sześćdziesiąt", "60", "5a"). Jednoliterowe odpadają: "A" z "Wrocławska 5A"
// jako osobne słowo złapałoby zwykłe polskie "a" ze środka zdania.
function distinguishingTokensOf(location) {
  const tokens = [...tokenizeForMatch(location.name), ...tokenizeForMatch(location.speechName || "")];
  return [...new Set(tokens)].filter((token) => token.length >= 2);
}

// Klient podał numer, tylko w odmienionej formie nazwy ulicy ("na Wrocławskiej sześćdziesiąt") —
// sama ulica jest niejednoznaczna (trzy salony), ale numer wskazuje jeden. Zawężamy wtedy listę
// zamiast pytać "który dokładnie?" o coś, co klient właśnie powiedział. To tylko ZAWĘŻA listę,
// której i tak już nie umieliśmy rozstrzygnąć — nigdy nie tworzy dopasowania z niczego.
function narrowCandidatesByNumber(speechTokens, candidates) {
  if (candidates.length < 2) return null;

  const hits = candidates.filter((candidate) => {
    const otherTokens = new Set(
      candidates.filter((other) => other !== candidate).flatMap(distinguishingTokensOf)
    );
    return distinguishingTokensOf(candidate).some(
      (token) => !otherTokens.has(token) && speechTokens.includes(token)
    );
  });

  return hits.length === 1 ? hits[0] : null;
}

// Kilka salonów potrafi zaczynać się od tego samego słowa (dziś: "Wrocławska" — 60 i 5A).
// Grupujemy dynamicznie z listy lokalizacji, więc dodanie kolejnego salonu na tej samej ulicy
// automatycznie trafia do właściwej grupy — bez ręcznego dopisywania nigdzie indziej.
// Ucina typową końcówkę polskiej odmiany przymiotnikowej ("Wrocławska" -> "wrocław", co łapie
// też "Wrocławskiej", "Wrocławską" itd.) — bez tego samo przejście na inny przypadek gramatyczny
// wystarczało, żeby ominąć wykrywanie niejednoznaczności między salonami na tej samej ulicy.
function wordStem(word) {
  const w = word.toLowerCase();
  return w.length > 5 ? w.slice(0, w.length - 3) : w;
}

function groupLocationsByFirstWord(locations) {
  const groups = {};
  locations.forEach((location) => {
    const stem = wordStem(location.name.split(/\s+/)[0]);
    (groups[stem] = groups[stem] || []).push(location);
  });
  return groups;
}

function findLocationMatchDeterministic(speech) {
  if (!speech) return { match: null, candidates: [], viaLandmark: false };
  const s = speech.toLowerCase();
  const speechTokens = tokenizeForMatch(speech);
  const locations = salonConfig.locations || [];

  // Dopasowanie precyzyjne (pełna nazwa z numerem, alias albo speechName) jest z definicji
  // jednoznaczne — wygrywa niezależnie od kolejności w tablicy.
  //
  // Celowo BEZ luzu na odmianę (fuzzy: false), w przeciwieństwie do landmarków niżej: alias
  // "Prądnicka" i landmark "Prądnik Czerwony" różnią się jedną literą w środku, więc dopuszczenie
  // tu odmiany przywróciłoby dokładnie tę kolizję, którą naprawiono 17.09.2026 — i to w najgorszym
  // miejscu, bo ten poziom daje PEWNE dopasowanie, bez pytania o potwierdzenie. Odmienioną formę
  // nazwy ulicy łapie i tak rdzeń ulicy niżej ("na Urzędniczej"), a numer — narrowCandidatesByNumber.
  //
  // Zamiast "pierwszy pasujący wygrywa" zbieramy WSZYSTKIE pasujące: gdyby kiedyś dwa salony dało
  // się opisać tą samą precyzyjną formą, lepiej zapytać, który, niż po cichu wziąć pierwszy z listy.
  const preciseMatches = locations.filter((location) =>
    preciseFormsOf(location).some((form) => speechContainsPhrase(speechTokens, form, { fuzzy: false }))
  );
  if (preciseMatches.length === 1) return { match: preciseMatches[0], candidates: [], viaLandmark: false };
  if (preciseMatches.length > 1) {
    const narrowed = narrowCandidatesByNumber(speechTokens, preciseMatches);
    if (narrowed) return { match: narrowed, candidates: [], viaLandmark: false };
    return { match: null, candidates: preciseMatches, viaLandmark: false };
  }

  // Punkty orientacyjne ("koło Multikina", "obok szpitala wojskowego") — dokładnie te słowa,
  // których klienci używają, gdy nie pamiętają adresu (od Wiktorii, 3.09.2026). Mniej pewne niż
  // nazwa ulicy, więc wołający route ma obowiązek to potwierdzić, zanim cokolwiek wyśle.
  //
  // UWAGA: to MUSI iść przed rdzeniem ulicy niżej. Zgłoszone przez Damiana 17.09.2026: klient
  // mówiący "Prądnik Czerwony" (dzielnica, landmark Kniaźniny 1) dostawał po cichu, BEZ pytania
  // o potwierdzenie, zgłoszenie do salonu Prądnicka 77 — bo rdzeń "Prądnicka" po obcięciu typowej
  // końcówki przymiotnikowej to "prądni" (wordStem tnie 3 znaki), a "prądnik czerwony" zawiera ten
  // sam rdzeń jako przypadkowy podciąg. Rdzeń ulicy jest traktowany jako PEWNE dopasowanie (bez
  // potwierdzenia), więc taka kolizja nigdy nie miała szansy dotrzeć do landmarku niżej. Landmarki
  // są z definicji bardziej swoiste (pełne, wyszukane frazy, nie automatyczne obcinanie), więc
  // sprawdzamy je najpierw — kolizja z Prądnickiej wciąż zajdzie, ale teraz jako niepewny landmark
  // z obowiązkowym pytaniem o potwierdzenie, zamiast cichego, pewnego trafienia w zły salon.
  //
  // TU dopuszczamy odmianę (fuzzy: true) — patrz komentarz przy wordFormsMatch. Landmarki są z
  // definicji niepewne i zawsze kończą się pytaniem o potwierdzenie, więc ewentualna pomyłka
  // kosztuje jedno dodatkowe pytanie, a nie złe zgłoszenie — inaczej niż na poziomie aliasów wyżej.
  const landmarkMatches = locations.filter((location) =>
    (location.landmarks || [])
      .map((landmark) => tokenizeForMatch(landmark))
      .some((landmark) => speechContainsPhrase(speechTokens, landmark, { fuzzy: true }))
  );
  if (landmarkMatches.length === 1) return { match: landmarkMatches[0], candidates: [], viaLandmark: true };
  if (landmarkMatches.length > 1) {
    // Klient podał numer przy odmienionej nazwie ulicy ("na Wrocławskiej sześćdziesiąt") — sama
    // ulica pasuje do trzech salonów, ale numer rozstrzyga. Nadal przez landmark, więc nadal
    // z potwierdzeniem.
    const narrowed = narrowCandidatesByNumber(speechTokens, landmarkMatches);
    if (narrowed) return { match: narrowed, candidates: [], viaLandmark: true };
    return { match: null, candidates: landmarkMatches, viaLandmark: false };
  }

  // Rdzeń pierwszego słowa nazwy ulicy — łapie odmianę przez przypadki bez ręcznego wypisywania
  // każdej formy z osobna (np. "Urzędnicze" zamiast "Urzędnicza", zgłoszone przez Wiktorię
  // 3.09.2026: "klienci często nie pamiętają numerów"). Gdy rdzeń wskazuje jednoznacznie jeden
  // salon, to nadal pewne dopasowanie — nie proszę o potwierdzenie, to wciąż ta sama ulica.
  // Gdy pasuje do kilku (np. samo "Wrocławska" — 60 i 5A), to niejednoznaczność do doprecyzowania.
  const streetGroups = groupLocationsByFirstWord(locations);
  for (const group of Object.values(streetGroups)) {
    const stem = wordStem(group[0].name.split(/\s+/)[0]);
    if (s.includes(stem)) {
      if (group.length === 1) return { match: group[0], candidates: [], viaLandmark: false };
      return { match: null, candidates: group, viaLandmark: false };
    }
  }

  // Dopasowanie po samej dzielnicy używamy tylko wtedy, gdy wskazuje jednoznacznie jeden salon —
  // kilka salonów w tej samej dzielnicy (np. "Krowodrza") nie powinno cicho wskazywać pierwszego z listy.
  // Sprawdzamy typowe odmiany przez przypadki ("na Krowodrzy", "w Nowej Hucie"), bo to właśnie tak
  // mówią prawdziwi rozmówcy — dopasowanie tylko do mianownika przepuszczało niejednoznaczność dalej.
  const districtMatches = locations.filter((location) => {
    const district = String(location.district || "").toLowerCase();
    return DISTRICT_KEYWORDS.some(({ stem, districtContains }) => district.includes(districtContains) && s.includes(stem));
  });

  if (districtMatches.length === 1) return { match: districtMatches[0], candidates: [], viaLandmark: false };
  return { match: null, candidates: districtMatches.length > 1 ? districtMatches : [], viaLandmark: false };
}

// Gdy findLocationMatch nie ustali salonu, trasy mogą tym sprawdzić, czy to dlatego, że wypowiedź
// jest NIEJEDNOZNACZNA (kilka salonów pasuje) — wtedy warto wymienić konkretne opcje zamiast
// ogólnego "powiedz jeszcze raz". Lista jest zawsze aktualna, bo liczona na żywo z konfiguracji.
function getAmbiguousLocationCandidates(speech) {
  return findLocationMatchDeterministic(speech).candidates;
}

function describeLocationOptions(candidates) {
  // Opisujemy punktami orientacyjnymi, jeśli je mamy — łatwiej rozpoznać "blisko Kleparza" niż
  // gołą nazwę ulicy, zwłaszcza gdy klient sam nie jest pewien dokładnego adresu.
  const options = candidates
    .map((l) => {
      const name = locationNameForSpeech(l);
      return l.landmarkSummary ? `${name} (${l.landmarkSummary})` : name;
    })
    .join(" albo ");
  return `Mamy tam kilka salonów: ${options}. Który dokładnie?`;
}

function locationNameForSpeech(locationOrName) {
  const rawName =
    typeof locationOrName === "string"
      ? locationOrName
      : locationOrName?.speechName || locationOrName?.name;
  if (!rawName) return "";
  // Fallback dla starszych wpisów bez speechName.
  return rawName.replace(/^Kniaźnina\s+1$/i, "Kniaźnina jeden");
}

// UWAGA: celowo BEZ AI-fallbacku. Był tu wcześniej (dla odmiany przez przypadki typu "na
// Prądnickiej"), ale w praktyce, gdy wypowiedź nie dawała żadnej wskazówki o lokalizacji
// (np. samo "chcę się zapisać"), AI systematycznie zgadywało pierwszy salon z listy zamiast
// uczciwie zwrócić "nie wiem" — mimo wyraźnej instrukcji w prompcie. Zaobserwowane trzykrotnie
// na żywych rozmowach. Dla decyzji, do którego salonu trafi zgłoszenie, wolimy dopytać niż zgadnąć.
async function findLocationMatch(speech) {
  if (!speech) return null;
  const { match } = findLocationMatchDeterministic(speech);
  return match;
}

function formatLocationLabel(location) {
  return `${location.name} (${location.district})`;
}

// Zabezpieczenie na wypadek, gdyby regex albo AI pomyliły nazwę salonu/ulicy z imieniem —
// widzieliśmy to naprawdę na produkcji ("Imię: Dywizjonu 303"). Odrzuca wartość, jeśli pasuje
// do nazwy albo aliasu jakiejś lokalizacji, zamiast wysyłać mylącą informację dalej.
function sanitizeNameField(value) {
  if (!value) return null;
  const lower = value.toLowerCase();
  const locations = salonConfig.locations || [];
  const looksLikeLocation = locations.some((location) => {
    const name = location.name.toLowerCase();
    const aliases = (location.aliases || []).map((a) => String(a).toLowerCase());
    return name.includes(lower) || lower.includes(name) || aliases.some((alias) => lower.includes(alias));
  });
  return looksLikeLocation ? null : value;
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractBarberName(text) {
  const m = (text || "").match(/(?:do|u|barber|barbera|barbera to|do barbera)\s+([a-ząćęłńóśźż\-]+)/i);
  return m ? capitalize(m[1]) : null;
}



// Zapis do listy "do oddzwonienia" (/admin/callbacks) — tylko dla tras, gdzie bot faktycznie
// obiecał klientowi telefon zwrotny. Kategoria i treść zgłoszenia to ten sam tekst, co idzie do
// Wiktorii SMS-em/WhatsAppem (bez tagu w nawiasie), żeby nie utrzymywać dwóch osobnych opisów tej
// samej sprawy. Wołane niezależnie od notifyInternalRecipients (i jego flagi włącz/wyłącz SMS) —
// logCallbackRequest nigdy nie rzuca, patrz callLog.js.
// keyBase to ten sam klucz, którym deduplikowana jest wysyłka do zespołu (notifyInternalRecipients) —
// dzięki temu powtórzony webhook Twilio nie robi drugiego wpisu w rejestrze, tak jak nie robi
// drugiego SMS-a. Patrz logCallbackRequest w callLog.js.
function logCallback({ callSid, category, from, body, keyBase }) {
  logCallbackRequest({
    callSid,
    category,
    clientPhone: from,
    summary: body.replace(/^\[[^\]]+\]\s*/, ""),
    dedupeKey: keyBase,
  });
}


// Bot nie może obiecywać SMS-a, którego nie wyśle. Wysyłka jest warunkowa: wyłączona flagą
// SEND_CLIENT_BOOKSY_SMS albo niemożliwa, gdy nie znamy numeru dzwoniącego (numer zastrzeżony).
// Wcześniej komunikat "Wysyłam Ci SMS-em link" leciał bezwarunkowo, więc część klientów słyszała
// obietnicę SMS-a, który nigdy nie dochodził — a potem jeszcze "skorzystaj z linku, który
// wysłaliśmy SMS-em". Znalezione w przeglądzie 15.09.2026.
function willSendBooksySms(clientPhone) {
  return process.env.SEND_CLIENT_BOOKSY_SMS === "true" && Boolean(clientPhone);
}

async function sendClientBooksySms({ key, to, twilioFrom, location }) {
  if (process.env.SEND_CLIENT_BOOKSY_SMS !== "true") return;
  if (!to) return;

  const from = process.env.TWILIO_SMS_FROM || twilioFrom;
  if (!from) return;

  if (!markMessageSent(key)) return;

  // Link do konkretnego salonu, jeśli go rozpoznaliśmy i ma zapisany dedykowany link Booksy —
  // w przeciwnym razie ogólny widget na wszystkie salony (klient wybierze sam).
  const link = (location && location.booksy) || BOOKSY_LINK;
  const salonNote = location ? ` w salonie ${location.name}` : "";

  await getTwilioClient().messages.create({
    to,
    from,
    body:
      `Dziękujemy za kontakt! Oto link do rezerwacji${salonNote} przez aplikację Booksy, gdzie widoczne są wszystkie dostępne terminy: ` +
      link,
  });

  console.log("Client Booksy SMS sent", { to, salon: location ? location.name : "ogólny link" });
}

module.exports = router;

// Wystawione wyłącznie do testów jednostkowych (test/*.test.js) — router pozostaje jedynym
// eksportem używanym przez aplikację (index.js), więc to nie zmienia publicznego interfejsu.
// Świadomie NIE eksportujemy niczego, co realnie woła OpenAI/Twilio (classifyIntent,
// extractLocationPhrase, getAIResponse, wysyłki) — testy mają być szybkie, darmowe i deterministyczne.
router._test = {
  detectIntent,
  resolveIntent,
  findLocationMatchDeterministic,
  wordFormsMatch,
  tokenizeForMatch,
  sanitizeNameField,
  extractBarberName,
  describeLocationOptions,
  isDeclinedAnswer,
  classifyFaqFollowup,
  willSendBooksySms,
  LATE_AREA_PROMPT,
  regex: {
    CANCELLATION_REGEX,
    TRANSFER_KEYWORDS_REGEX,
    GENERAL_DECLINE_REGEX,
    LATE_SIGNAL_REGEX,
    SHORT_AFFIRMATION_REGEX,
    FAQ_KEYWORDS_REGEX,
    COOPERATION_REGEX,
  },
};
