# Barber Bot AI — Telefoniczny asystent dla salonów barberskich

Bot odbiera połączenia telefoniczne i prowadzi klienta przez trzy ścieżki: ZAPIS, SPÓŹNIENIE, INNE.

## Stack

- **Twilio Voice** — polski numer +48, odbieranie połączeń, TTS (głos `Polly.Ewa-Neural`)
- **OpenAI GPT-4o-mini** — rozumienie pytań i generowanie odpowiedzi
- **Node.js + Express** — serwer webhooka

## Struktura projektu

```
kruk-bot-ai/
├── index.js                  # Entry point, serwer Express
├── src/
│   ├── config/
│   │   └── salon.js          # ← EDYTUJ TO: dane salonu, cennik, godziny
│   ├── routes/
│   │   └── voice.js          # Webhooks Twilio Voice (incoming + answer)
│   └── services/
│       └── ai.js             # Integracja OpenAI, system prompt
├── .env.example              # Szablon zmiennych środowiskowych
└── package.json
```

## Uruchomienie lokalne

### 1. Zmienne środowiskowe

```bash
cp .env.example .env
# Uzupełnij TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, OPENAI_API_KEY
```

### 2. Zainstaluj zależności i uruchom

```bash
npm install
npm run dev
```

### 3. Wyeksponuj lokalny serwer przez ngrok

Twilio musi mieć publiczny URL do webhooków. W trybie dev użyj [ngrok](https://ngrok.com/):

```bash
ngrok http 3000
```

Skopiuj HTTPS URL (np. `https://abc123.ngrok-free.app`) i wstaw do `.env`:

```
BASE_URL=https://abc123.ngrok-free.app
```

### 4. Konfiguracja Twilio

1. Zaloguj się do [console.twilio.com](https://console.twilio.com)
2. Kup numer z Польski (+48): **Phone Numbers → Buy a Number → Country: Poland**
3. W ustawieniach numeru ustaw webhook:
   - **A call comes in:** `https://twoj-url.ngrok-free.app/voice/incoming`
   - Method: `HTTP POST`

## Dostosowanie salonu

Edytuj [src/config/salon.js](src/config/salon.js) — zmień nazwę, adresy, godziny, cennik oraz sekcję `notifications`.

Najważniejsze pola w `notifications`:
- `wiktoriaPhone`, `damianPhone` — odbiorcy dla ścieżek ZAPIS i INNE.
- `salonWhatsAppGroups` — mapa lokalizacji salonu do listy odbiorców dla ścieżki SPÓŹNIENIE.
- `defaultSalonGroup` — fallback, gdy nie uda się rozpoznać lokalizacji.

Kanał powiadomień wewnętrznych ustawiasz przez `.env`:
- `INTERNAL_NOTIFICATIONS_CHANNEL=whatsapp` (domyślnie)
- `TWILIO_WHATSAPP_FROM=whatsapp:+...` (nadawca WhatsApp)
- alternatywnie `INTERNAL_NOTIFICATIONS_CHANNEL=sms`

## Wdrożenie produkcyjne

Zalecane platformy:
- **Railway / Render** — prosty deploy z GitHuba, bezpłatny tier
- **Fly.io** — dobra latencja w EU
- **VPS (Hetzner)** — pełna kontrola, tani serwer w Niemczech (niska latencja PL)

W produkcji ustaw `NODE_ENV=production` — włączy to weryfikację sygnatury Twilio.

## Koszty (orientacyjnie)

| Składnik | Koszt |
|---|---|
| Twilio numer +48 | ~$1/mies |
| Twilio połączenie przychodzące | ~$0.0085/min |
| Twilio TTS (Polly Neural) | wliczony w połączenie |
| Twilio Speech Recognition | ~$0.02/15 sek |
| OpenAI GPT-4o-mini | ~$0.0001/pytanie |

Typowa rozmowa (3 pytania, 2 min) ≈ **$0.08**
