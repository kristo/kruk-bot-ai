/**
 * Dane Kruk Barbershop — pobrane z krukbarbershop.pl
 */

const salonConfig = {
  name: "Kruk Barbershop",
  city: "Kraków",
  declaredBranchCount: 9,
  phone: "+48 666 241 442",
  email: "krukbarbershop@gmail.com",
  website: "https://www.krukbarbershop.pl",
  rating: "4.8 gwiazdki (ponad 300 opinii Google)",

  hours: {
    "poniedziałek": "8:00–20:00",
    "wtorek":       "8:00–20:00",
    "środa":        "8:00–20:00",
    "czwartek":     "8:00–20:00",
    "piątek":       "8:00–20:00",
    "sobota":       "8:00–16:00",
    "niedziela":    "nieczynne",
  },

  // Rozszerzona baza ulic/punktów orientacyjnych dla każdego salonu — od Krzysztofa, 21.09.2026,
  // po zgłoszeniu, że dopasowanie po lokalizacji przy spóźnieniach działa najsłabiej ze wszystkiego.
  // Źródło: szczegółowy podział "rejon / główne ulice / blisko" per salon, przygotowany osobno.
  //
  // ZASADA BEZPIECZEŃSTWA (ta sama co przy kolizji Prądnik Czerwony/Prądnicka, patrz
  // findLocationMatchDeterministic w voice.js): gdy jedna ulica/punkt orientacyjny leży blisko
  // WIĘCEJ NIŻ JEDNEGO salonu (np. ul. Wrocławska biegnie koło Wrocławskiej 60, Wrocławskiej 5A
  // i Prądnickiej 77; al. Bora-Komorowskiego koło Dywizjonu 303 i Kniaźniny), ten sam wpis jest
  // celowo POWTÓRZONY w landmarks każdego z tych salonów. Matcher w voice.js traktuje landmark
  // pasujący do >1 salonu jako niejednoznaczny (lista kandydatów do wyboru), a nie ciche trafienie
  // w pierwszy z brzegu — więc duplikat tu jest zamierzony, nie pomyłka kopiuj-wklej.
  // Wyjątek: "Bohaterów Września" jest ulicą WŁASNĄ salonu Bohaterów Września 1E (już pokryte
  // aliasami tego salonu, sprawdzanymi PRZED landmarkami) — celowo NIE powtórzone jako landmark
  // Kniaźniny 1, bo i tak nigdy by nie zadziałało (alias wygrywa wcześniej) i tylko myliłoby czytelnika.
  //
  // WPISUJEMY TYLKO MIANOWNIK, BEZ ODMIAN I BEZ WARIANTÓW BEZ OGONKÓW. Od 21.09.2026 dopasowanie
  // porównuje słowo po słowie z luzem na końcówkę fleksyjną i zdejmuje polskie znaki (patrz
  // wordFormsMatch w voice.js), więc sam "Serenada" łapie "koło Serenady", a "Plac Bieńczycki"
  // łapie "przy Placu Bieńczyckim". Wcześniej odmiany dopisywano tu ręcznie — 63 wpisy, które i tak
  // nie pokrywały wszystkiego (bot nie rozumiał własnej podpowiedzi "koło Multikina"). Dopisanie
  // odmiany nic dziś nie naprawi, tylko zaciemni listę; jeśli jakaś forma nie działa, to znaczy,
  // że regułę trzeba poprawić w voice.js, a nie obchodzić ją tutaj.
  locations: [
    {
      name: "Wrocławska 60",
      speechName: "Wrocławska sześćdziesiąt",
      district: "Krowodrza / centrum",
      parking: "Strefa C wzdłuż ulicy Wrocławskiej, po przeciwnej stronie strefa B (płatna).",
      booksy: "https://booksy.com/pl-pl/16323_kruk-barbershop-wroclawska-60_barber-shop_8820_krakow",
      aliases: ["wrocławska 60", "wroclawska 60", "wrocławska sześćdziesiąt", "wroclawska szescdziesiat"],
      // Punkty orientacyjne, których klienci używają, gdy nie pamiętają dokładnego adresu —
      // od Wiktorii (3.09.2026). Traktowane jako mniej pewne niż nazwa ulicy: dopasowanie
      // przez landmark wymaga potwierdzenia, zanim bot cokolwiek wyśle.
      // "Cichy Kącik"/"Bronowice" — z ogólnej wiedzy o topografii Krakowa (nie od Wiktorii).
      // Reszta (ulice + "blisko") — od Krzysztofa, 21.09.2026, patrz komentarz nad tablicą lokalizacji.
      // "Wrocławska" i "Mazowiecka" dzielone z Wrocławską 5A (a sama "Wrocławska" też
      // z Prądnicką 77) — patrz zasada bezpieczeństwa wyżej.
      landmarks: [
        "w głębi osiedla", "PKP Łobzów", "róg z Poznańską", "Poznańska", "Cichy Kącik", "Bronowice",
        "Łokietka", "Racławicka", "Kijowska", "Biprostal", "Radio Kraków", "Dworzec Towarowy",
        "Wrocławska", "Mazowiecka", "Królewska", "Nowy Kleparz", "Plac Inwalidów", "Park Krakowski",
        "AGH",
      ],
      landmarkSummary: "w głębi osiedla przy Łokietka, blisko Nowego Kleparza i AGH",
    },
    {
      name: "Urzędnicza 48",
      speechName: "Urzędnicza czterdzieści osiem",
      district: "Krowodrza / Stare Miasto",
      parking: "Liczne zatoki parkingowe w okolicy, strefa A (płatna). Tramwaje ulicą Królewską – kilka kroków od salonu.",
      booksy: "https://booksy.com/pl-pl/214909_kruk-barbershop-urzednicza-48_barber-shop_8820_krakow",
      // Jedyny salon na tej ulicy — sama nazwa ulicy jest bezpiecznym, jednoznacznym aliasem.
      aliases: ["urzędnicza", "urzednicza"],
      // "Plac Inwalidów"/"Park Krakowski" potwierdzone (i doprecyzowane jako dzielone z innymi
      // salonami) przez nową bazę od Krzysztofa, 21.09.2026 — patrz komentarz nad tablicą lokalizacji.
      landmarks: [
        "koło Lea", "Lea", "Park Krakowski", "Chopina", "Królewska", "UEK", "UKEN", "Plac Inwalidów",
        "Czarnowiejska", "Głowackiego", "Miasteczko Studenckie AGH", "AGH", "Stadion Wisły", "Błonia",
      ],
      landmarkSummary: "koło AGH i Błoń, przy Parku Krakowskim",
    },
    {
      name: "Dywizjonu 303 31E",
      speechName: "Dywizjonu trzysta trzy trzydzieści jeden E",
      district: "Nowa Huta (między os. Dywizjonu a os. Strusia)",
      parking: "Darmowy parking po obu stronach ulicy, tuż przy lokalu.",
      booksy: "https://booksy.com/pl-pl/69423_kruk-barbershop-dywizjonu-303-31e-od-strony-andersa_barber-shop_8820_krakow",
      aliases: ["dywizjonu", "dywizjon", "dywizjonu 303"],
      // "Rondo Czyżyńskie"/"Muzeum Lotnictwa"/"Andersa" z ogólnej wiedzy o topografii Krakowa,
      // reszta od Krzysztofa, 21.09.2026. "Andersa" dzielone z Niepodległości 3A (al. Andersa
      // biegnie koło obu), "Bora-Komorowskiego" dzielone z Kniaźniną 1 — patrz zasada bezpieczeństwa
      // nad tablicą lokalizacji.
      landmarks: [
        "Czyżyny", "koło Andersa", "Andersa", "Olsza", "Rondo Czyżyńskie", "Muzeum Lotnictwa",
        "Stella-Sawickiego", "Jana Pawła II", "Medweckiego", "Tauron Arena", "Park Lotników",
        "CH Czyżyny", "M1", "EXPO Kraków", "Osiedle Avia", "Bora-Komorowskiego",
      ],
      landmarkSummary: "w Czyżynach, koło Tauron Areny i Muzeum Lotnictwa",
    },
    {
      name: "Kniaźnina 1",
      speechName: "Kniaźnina jeden",
      district: "Nowa Huta, osiedle Oświecenia",
      parking: "Darmowy parking w głębi os. Oświecenia i przy centrum handlowym Serenada. Blisko przystanku tramwajowego linii Mistrzejowice–Lema.",
      booksy: "https://booksy.com/pl-pl/93101_kruk-barbershop-kniaznina-1_barber-shop_8820_krakow",
      aliases: ["kniaźnina", "kniaznina"],
      // Reszta (ulice + "blisko" + dzielone z Bohaterów Września 1E) — od Krzysztofa, 21.09.2026,
      // patrz komentarz nad tablicą lokalizacji. "Piastów"/"Jancarza"/"Srebrnych Orłów"/"Plac
      // Bieńczycki"/"Park Tysiąclecia"/"Szpital Rydygiera" dzielone z Bohaterów Września 1E — oba
      // salony leżą blisko siebie (Mistrzejowice/Bieńczyce), więc te punkty orientacyjne SAME W
      // SOBIE nie rozróżniają, który salon — matcher pokaże oba do wyboru, co jest uczciwe.
      landmarks: [
        "Meissnera", "Bora-Komorowskiego", "Prądnik Czerwony", "Bohomolca", "Multikino", "Serenada",
        "park wodny", "Piasta Kołodzieja", "Pętla Mistrzejowice", "Park Tysiąclecia",
        "Lidl Mistrzejowice", "Osiedle Piastów", "Piastów", "Jancarza", "Srebrnych Orłów",
        "Plac Bieńczycki", "Szpital Rydygiera",
      ],
      landmarkSummary: "w Mistrzejowicach koło Multikina i Serenady, blisko Parku Tysiąclecia",
    },
    {
      name: "Komandosów 21",
      speechName: "Komandosów dwadzieścia jeden",
      district: "Dębniki, osiedle Podwawelskie",
      parking: "Liczne miejsca parkingowe w strefie C w okolicy.",
      booksy: "https://booksy.com/pl-pl/295786_kruk-barbershop-komandosow-21_barber-shop_8820_krakow",
      aliases: ["komandosów", "komandosow"],
      // "Most Dębnicki"/"Zakrzówek" z ogólnej wiedzy o topografii Krakowa, teraz potwierdzone
      // (i uzupełnione o resztę ulic/"blisko") przez nową bazę od Krzysztofa, 21.09.2026.
      landmarks: [
        "osiedle Podwawelskie", "Podwawelskie", "ICE Kraków", "centrum kongresowe",
        "Centrum Kongresowe ICE", "bulwary wiślane", "Wawel", "Kazimierz", "Most Dębnicki", "Zakrzówek",
        "Kapelanka", "Monte Cassino", "Konopnickiej", "Kobierzyńska", "Rondo Grunwaldzkie",
        "Hotel Forum",
      ],
      landmarkSummary: "na Podwawelskim przy Kapelanka i Monte Cassino, blisko ICE Kraków",
    },
    {
      name: "Bohaterów Września 1E",
      speechName: "Bohaterów Września jeden E",
      district: "Mistrzejowice (Nowa Huta)",
      parking: "Darmowy parking przy lokalu, obok Lewiatana, za blokiem oraz po drugiej stronie ulicy. Komunikacja: przystanek Kleeberga.",
      booksy: "https://booksy.com/pl-pl/300487_kruk-barbershop-bohaterow-wrzesnia-1e_barber-shop_8820_krakow",
      aliases: ["bohaterów września", "bohaterow wrzesnia", "bohaterów", "bohaterow"],
      // Reszta — od Krzysztofa, 21.09.2026. Dzielone z Kniaźniną 1 (patrz komentarz tam) — oba
      // salony leżą blisko siebie, więc te punkty orientacyjne same w sobie są niejednoznaczne.
      landmarks: [
        "Mistrzejowice", "koło Piastów", "Piastów", "Wiślicka", "DH Wanda", "Pętla Piasta Kołodzieja",
        "Osiedle Bohaterów Września", "Piasta Kołodzieja", "Jancarza", "Srebrnych Orłów",
        "Plac Bieńczycki", "Park Tysiąclecia", "Szpital Rydygiera",
      ],
      landmarkSummary: "w Bieńczycach przy Placu Bieńczyckim, koło DH Wanda",
    },
    {
      name: "Prądnicka 77",
      speechName: "Prądnicka siedemdziesiąt siedem",
      district: "Krowodrza",
      parking: "Salon znajduje się przy ul. Prądnickiej 77, obok Żabki, apteki i cukierni. Dojazd autem, autobusem i tramwajem; przystanki 2-3 minuty pieszo.",
      booksy: "https://booksy.com/pl-pl/346265_kruk-barbershop-pradnicka-77_barber-shop_8820_krakow",
      aliases: ["pradnicka", "prądnicka", "77", "pradnickiej", "prądnickiej"],
      // Reszta — od Krzysztofa, 21.09.2026. "Wrocławska" dzielona z Wrocławską 60 i 5A —
      // patrz zasada bezpieczeństwa nad tablicą lokalizacji.
      landmarks: [
        "Żabiniec", "szpital Narutowicza", "szpital Jana Pawła", "Krowodrza Górka", "park kleparski",
        "Opolska", "Bratysławska", "Fieldorfa-Nila", "Plac Imbramowski", "IKEA", "Galeria Bronowice",
        "Castorama", "Makro", "Prądnik Biały", "Wrocławska",
      ],
      landmarkSummary: "na Prądniku Białym, koło IKEA i szpitala Narutowicza",
    },
    {
      name: "Wrocławska 5A",
      speechName: "Wrocławska pięć A",
      district: "Krowodrza",
      parking: "Darmowy parking wzdłuż ulicy Wrocławskiej i na bocznych uliczkach (obowiązuje płatna strefa). Kilka minut pieszo od węzła przesiadkowego Nowy Kleparz, linia autobusowa 130 jedzie wprost ulicą Wrocławską.",
      // Nowy salon — strona nie publikuje jeszcze dedykowanego linku Booksy dla tego adresu
      // (widget zbiorczy zawiera jego ID, ale bez przypisania do konkretnej lokalizacji). Zweryfikować ręcznie.
      booksy: null,
      aliases: ["wroclawska 5a", "5a", "wroclawska5a"],
      // Reszta — od Krzysztofa, 21.09.2026. "Wrocławska", "Mazowiecka", "Nowy Kleparz" i "Plac
      // Inwalidów" dzielone z Wrocławską 60 (a sama "Wrocławska" też z Prądnicką 77) — patrz
      // zasada bezpieczeństwa nad tablicą lokalizacji.
      landmarks: [
        "blisko Kleparza", "Kleparz", "szpital wojskowy", "Galeria Krakowska", "Długa", "Lubelska",
        "al. Słowackiego", "Stary Kleparz", "Politechnika Krakowska", "Dworzec Główny", "Wrocławska",
        "Mazowiecka", "Nowy Kleparz", "Plac Inwalidów",
      ],
      landmarkSummary: "przy Nowym Kleparzu i Galerii Krakowskiej, obok szpitala wojskowego",
    },
    {
      name: "Niepodległości 3A",
      speechName: "Niepodległości trzy A",
      district: "Nowa Huta",
      // Strona podstrony tej lokalizacji jest jeszcze pusta (brak opisu dojazdu/parkingu w treści) — do uzupełnienia po publikacji przez klienta.
      parking: "Brak szczegółowych danych na stronie — do potwierdzenia bezpośrednio z salonem.",
      // "Rondo Kocmyrzowskie" teraz potwierdzone przez nową bazę od Krzysztofa, 21.09.2026 (razem
      // z resztą ulic/"blisko" poniżej). "Carrefour Czyżyny" USUNIĘTE tą samą okazją — ta nowa,
      // szczegółowa baza umiejscawia Czyżyny wyraźnie przy Dywizjonu 303 (patrz landmarks tego
      // salonu), a nie tutaj; stary wpis był niepotwierdzonym strzałem z 11.09.2026 i najpewniej
      // wskazywał zły salon. "Andersa" dzielone z Dywizjonu 303 31E (al. Andersa biegnie koło obu)
      // — patrz zasada bezpieczeństwa nad tablicą lokalizacji.
      landmarks: [
        "Bieńczyce", "osiedle przy Arce", "Arce", "Rondo Kocmyrzowskie", "al. Andersa", "Andersa",
        "al. Róż", "Aleja Róż", "Kocmyrzowska", "Bieńczycka", "Solidarności", "Plac Centralny",
        "Teatr Ludowy", "NCK", "Zalew Nowohucki", "Łąki Nowohuckie", "Szpital Żeromskiego",
      ],
      landmarkSummary: "w ścisłym centrum Nowej Huty, przy Placu Centralnym i Alei Róż",
      booksy: null,
      aliases: ["niepodległości", "niepodleglosci", "3a"],
    },
  ],

  services: [
    // Popularne
    { name: "Strzyżenie (haircut)",                price: "90 zł",  duration: "45 min" },
    { name: "Broda (beard)",                       price: "70 zł",  duration: "30 min" },
    { name: "Strzyżenie + broda (combo)",          price: "130 zł", duration: "60 min" },
    { name: "Strzyżenie dziecka 5–12 lat",         price: "85 zł",  duration: "30 min" },
    { name: "Stylizacja włosów",                   price: "30 zł",  duration: "15 min" },
    // Tata + Syn
    { name: "Tata + Syn (5–12 lat) – strzyżenie",       price: "155 zł", duration: "75 min" },
    { name: "Tata (combo) + Syn (5–12 lat) – strzyżenie", price: "190 zł", duration: "90 min" },
    // Długie włosy
    { name: "Strzyżenie długich włosów (od 10 cm)", price: "120 zł", duration: "60 min" },
    { name: "Strzyżenie długich włosów + broda",   price: "160 zł", duration: "75 min" },
    // Tonowanie / farbowanie
    { name: "Broda + tonowanie",                   price: "125 zł", duration: "45 min" },
    { name: "Strzyżenie + tonowanie włosów",       price: "150 zł", duration: "60 min" },
    { name: "Combo + tonowanie brody",             price: "180 zł", duration: "75 min" },
    { name: "Combo + tonowanie włosów",            price: "180 zł", duration: "75 min" },
    { name: "Combo + tonowanie całości",           price: "200 zł", duration: "90 min" },
    // Bez nożyczek
    { name: "Strzyżenie maszynką – jedna długość", price: "40 zł",  duration: "15 min" },
    { name: "Buzzcut (maszynka cieniowanie)",      price: "75 zł",  duration: "30 min" },
    { name: "Łysa głowa golarką",                  price: "60 zł",  duration: "30 min" },
    { name: "Maszynka jedna długość + broda",      price: "100 zł", duration: "45 min" },
    { name: "Buzzcut + broda",                     price: "115 zł", duration: "45 min" },
  ],

  about: {
    staff: "9 salonów, 22 stanowiska, 23 profesjonalnych barberów.",
    products: "Pracujemy wyłącznie na kosmetykach Reuzel, Uppercut, Proraso i American Crew.",
    atmosphere: "Luźna atmosfera – możesz pogadać albo pomilczeć. Oferujemy kawę lub schłodzone whiskey.",
    techniques: "Fade, skin fade, texturing, cięcie na sucho i mokro, brzytwa, tonowanie włosów i brody.",
  },

  vouchers: {
    info:
      "Tak, mamy vouchery/bony podarunkowe — częsty prezent. Trzeba podejść do najbliższego salonu i uzgodnić z barberem na miejscu, na jaką usługę/kwotę ma opiewać. Barber wypisze voucher od ręki. Ważne: voucher można wykorzystać w KAŻDYM salonie Kruk Barbershop w Krakowie, nie tylko tym, gdzie został wystawiony.",
  },

  booking: {
    info: "Rezerwacje przez Booksy lub telefonicznie pod numer +48 666 241 442 w godzinach otwarcia.",
    url: "https://booksy.com/pl-pl/instant-experiences/widget/93101,16323,295786,214909,69423,300487,346265,353769,356253?instant_experiences_enabled=true&ig_ix=true",
    phone: "+48 666 241 442",
  },

  notifications: {
    // Numery docelowe do powiadomień wewnętrznych.
    // Możesz podawać same numery (np. +48600100200) albo adresy whatsapp:+48600100200.
    //
    // UWAGA 18.09.2026: stary numer Wiktorii (+48 666 241 442, ten sam co publiczny "phone"
    // salonu wyżej) od teraz jest PRZEKIEROWANY NA BOTA — Wiktoria dostała nowy, osobisty numer.
    // Publiczne pola "phone"/"booking.phone" celowo ZOSTAJĄ przy starym numerze (to on ma
    // dzwonić do bota — o to chodzi w tej zmianie). Ale wszystko poniżej, co ma realnie DOTRZEĆ
    // do Wiktorii (SMS, przekierowanie na żywo, fallback), musi wskazywać na NOWY numer — inaczej
    // powiadomienie/połączenie poleci z powrotem do bota, nie do niej.
    wiktoriaPhone: "+48 666 241 442",
    // damianPhone USUNIĘTE 18.09.2026 — od Krzysztofa: "damianPhone to tak naprawdę mój numer,
    // możesz usunąć". +48 698 685 251 to prywatny numer Krzysztofa, wpisany tu tymczasowo przy
    // pierwotnej konfiguracji jako placeholder, nie prawdziwy numer Damiana. Zostawienie go
    // znaczyłoby, że Krzysztof dostawałby SMS-y o każdym ZAPISIE/INNE/EN/JĘZYK?/WSPÓŁPRACY, myśląc
    // że to Damian je widzi. getBookingInternalRecipients() w notify.js nadal sprawdza
    // DAMIAN_PHONE / damianPhone (przez ?. — nic się nie wywali bez tego pola) — gdy pojawi się
    // prawdziwy numer Damiana, wystarczy go tu dopisać, bez zmian w kodzie.

    // consultantPhone USUNIĘTE 18.09.2026 — Krzysztof: rezygnujemy z przekierowania na żywo do
    // konsultanta (<Dial>). Prośba o człowieka nadal jest rozpoznawana (TRANSFER_KEYWORDS_REGEX
    // w voice.js), ale zawsze kończy się tą samą obietnicą oddzwonienia co inne zgłoszenia —
    // patrz respondWithHumanCallbackPromise. Ten numer nie jest już nigdzie odczytywany.

    // Fallback, gdy nie uda się rozpoznać konkretnej lokalizacji ze zgłoszenia spóźnienia.
    // Wiktoria zaktualizowana 18.09.2026 z tego samego powodu co wyżej; numer Krzysztofa
    // (dawne "damianPhone") usunięty z tej listy z tego samego powodu co wyżej.
    defaultSalonGroup: ["+48 666 241 442"],

    // "Grupa salonowa" modelowana jako lista odbiorców dla danej lokalizacji.
    // Numery zdefiniowane dla każdego salonu (format międzynarodowy PL).
    // Lista i przypisania od Wiktorii (2.09.2026) — poprzednia wersja miała pomieszane numery
    // między salonami (np. Niepodległości 3A wcześniej w ogóle nie miało własnej grupy).
    salonWhatsAppGroups: {
      "Wrocławska 60": [
        "+48 574 177 883", // Alex
        "+48 535 499 276", // Pchełka
        "+48 504 615 745", // Gabi
        "+48 732 555 762", // Patryk
        "+48 692 341 619", // Ola
        "+48 666 241 442", // Wiki (Wiktoria)
      ],
      "Urzędnicza 48": [
        "+48 517 721 439", // Patryk
        "+48 692 617 263", // Michał
        "+48 515 964 351", // Kuba
        "+48 698 013 368", // Karolina
        "+48 666 241 442", // Wiki (Wiktoria)
        "+48 513 837 454", // Emilia
      ],
      "Dywizjonu 303 31E": [
        "+48 536 050 506", // Maciek
        "+48 793 262 262", // Marta
        "+48 662 508 503", // Janek
        "+48 530 148 045", // Andrzej — poprawiony 30.09.2026 na rzeczywisty numer WhatsApp (stary,
        // +48 797 310 501, nie był jego WhatsAppem — pierwsze powiadomienie po włączeniu WhatsAppu
        // dla wszystkich barberów w ogóle do niego nie trafiało)
        "+48 537 234 332", // Wiktoria (barber)
        "+48 570 002 662", // Rafał
        "+48 721 071 283", // Amelia
        "+48 666 241 442", // Wiki (Wiktoria)
      ],
      "Kniaźnina 1": [
        "+48 533 632 022", // Szymon
        "+48 505 080 523", // Marta
        "+48 511 605 801", // Sajgon
        "+48 536 569 025", // Bartek
        "+48 666 241 442", // Wiki (Wiktoria)
        "+48 515 844 987", // Aga
      ],
      "Komandosów 21": [
        "+48 575 244 199", // Wiktor
        "+48 666 241 442", // Wiki (Wiktoria)
        "+48 515 964 351", // Kuba
      ],
      "Bohaterów Września 1E": [
        "+48 503 463 109", // Maja
        "+48 535 354 339", // Patrycja
        "+48 721 259 910", // Natalia
        "+48 666 241 442", // Wiki (Wiktoria)
        "+48 535 739 740", // Wiktoria (barber)
        "+48 609 222 721", // Paulina (Paula) — dopisana 30.09.2026, od Damiana
      ],
      "Prądnicka 77": [
        "+48 697 171 567", // Daga
        "+48 732 924 082", // Paweł
        "+48 666 241 442", // Wiki (Wiktoria)
        "+48 515 964 351", // Kuba
      ],
      "Wrocławska 5A": [
        "+48 666 241 442", // Wiki (Wiktoria)
        "+48 796 262 803", // Piotr
      ],
      "Niepodległości 3A": [
        "+48 516 473 388", // Tomek
        "+48 786 945 590", // Gabrysia
        "+48 666 241 442", // Wiki (Wiktoria)
        "+48 533 251 670", // Monika
      ],
    },
  },
};

module.exports = salonConfig;
