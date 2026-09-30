/**
 * Powiadomienia do zespołu (Wiktoria/Damian, grupy salonowe) i wspólna obsługa klienta Twilio.
 *
 * Wyodrębnione z voice.js 17.09.2026, kiedy doszła obsługa SMS-ów przychodzących — te same
 * numery, ten sam kanał (SMS/WhatsApp) i ta sama deduplikacja są potrzebne w dwóch miejscach,
 * a druga kopia logiki numerów telefonów rozjechałaby się przy pierwszej zmianie konfiguracji.
 */
const twilio = require("twilio");
const salonConfig = require("../config/salon");

let twilioClient = null;
function getTwilioClient() {
  if (!twilioClient) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

// Klucze już wysłanych wiadomości, żeby powtórzony webhook Twilio nie wysłał tego samego SMS-a
// dwa razy. Wpisy wygasają — wcześniej był to Set rosnący w nieskończoność przez cały czas życia
// procesu. Powtórki Twilio przychodzą w ciągu sekund, więc godzina to i tak duży zapas.
// Uwaga: to pamięć procesu, więc redeploy czyści okno deduplikacji. Trwały ślad zgłoszenia i tak
// jest deduplikowany w bazie (dedupe_key w callLog.js).
const SENT_MESSAGE_KEY_TTL_MS = 60 * 60 * 1000;
const sentMessageKeys = new Map();

function markMessageSent(key) {
  const now = Date.now();
  for (const [existingKey, sentAt] of sentMessageKeys) {
    if (now - sentAt > SENT_MESSAGE_KEY_TTL_MS) sentMessageKeys.delete(existingKey);
  }
  if (sentMessageKeys.has(key)) return false;
  sentMessageKeys.set(key, now);
  return true;
}

function getBookingInternalRecipients() {
  const recipients = [
    process.env.WIKTORIA_PHONE || salonConfig.notifications?.wiktoriaPhone,
    process.env.DAMIAN_PHONE || salonConfig.notifications?.damianPhone,
  ].filter(Boolean);

  return [...new Set(recipients)];
}

function getLateRecipients(locationMatch) {
  const groupsMap = salonConfig.notifications?.salonWhatsAppGroups || {};
  if (locationMatch) {
    const exact = groupsMap[locationMatch.name];
    if (Array.isArray(exact) && exact.length > 0) {
      return [...new Set(exact.filter(Boolean))];
    }

    const byNormalizedKey = Object.keys(groupsMap).find(
      (key) => key.toLowerCase() === locationMatch.name.toLowerCase()
    );
    if (byNormalizedKey && Array.isArray(groupsMap[byNormalizedKey])) {
      return [...new Set(groupsMap[byNormalizedKey].filter(Boolean))];
    }
  }

  const fallback = salonConfig.notifications?.defaultSalonGroup || getBookingInternalRecipients();
  return [...new Set((fallback || []).filter(Boolean))];
}

function isInternalNotificationsEnabled() {
  return (
    process.env.SEND_INTERNAL_NOTIFICATIONS === "true" ||
    process.env.SEND_INTERNAL_SMS === "true"
  );
}

// 30.09.2026: szablon WhatsApp (patrz sendInternalNotification) został zatwierdzony przez Metę,
// więc WhatsApp dociera niezawodnie do każdego odbiorcy — nawet bez wcześniejszej sesji (barberzy
// nigdy nie pisali do bota). To zamyka pilotaż z 24.09.2026 (Krzysztof/Damian/Wiktoria na
// WhatsAppie, reszta na SMS-ie) i backup SMS z 26.09.2026 (zabezpieczenie na czas zatwierdzania
// szablonu) — oba były tymczasowe i oba odpadły: na żądanie Krzysztofa cały zespół, łącznie z
// barberami z każdego salonu (patrz salonWhatsAppGroups w config/salon.js), idzie teraz na
// WhatsApp jednym kanałem z INTERNAL_NOTIFICATIONS_CHANNEL. SMS wciąż dostępny przez zmianę tej
// zmiennej — WhatsApp jest tańszy, więc to on jest teraz domyślny.
function getInternalChannel() {
  return (process.env.INTERNAL_NOTIFICATIONS_CHANNEL || "whatsapp").toLowerCase();
}

function normalizePhoneNumber(phone) {
  if (!phone) return phone;
  const prefix = phone.startsWith("whatsapp:") ? "whatsapp:" : "";
  const digits = phone.replace(/^whatsapp:/, "").replace(/[\s()-]/g, "");
  return `${prefix}${digits}`;
}

function asChannelAddress(channel, phone) {
  if (!phone) return phone;
  const normalized = normalizePhoneNumber(phone);
  if (channel === "whatsapp") {
    return normalized.startsWith("whatsapp:") ? normalized : `whatsapp:${normalized}`;
  }
  return normalized.replace(/^whatsapp:/, "");
}

function getInternalFromAddress(channel, twilioCallTo) {
  if (channel === "whatsapp") {
    const configured = process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_SMS_FROM || twilioCallTo;
    return asChannelAddress(channel, configured);
  }

  return normalizePhoneNumber(process.env.TWILIO_SMS_FROM) || twilioCallTo;
}

function getTestRecipients() {
  return (process.env.TEST_NOTIFICATION_RECIPIENTS || "")
    .split(",")
    .map((phone) => phone.trim())
    .filter(Boolean);
}

// Szablon WhatsApp (HSM) zatwierdzony przez Metę pozwala dostarczyć wiadomość nawet poza
// 24h oknem sesji — bez niego freeform WhatsApp do kogoś, kto nie pisał wcześniej do bota,
// kończy się błędem Twilio 63016 (i tak stracił Damian/Wiktoria 25-26.09.2026, dopóki sami nie
// napisali na numer bota). Ustawiany dopiero po akceptacji szablonu przez Metę — do tego czasu
// WhatsApp leci freeform jak dotąd (działa tylko w oknie sesji).
async function sendInternalNotification({ key, to, from, channel, body }) {
  if (!to || !from || !body) return;
  if (!markMessageSent(key)) return;

  const templateSid = channel === "whatsapp" ? process.env.TWILIO_WHATSAPP_TEMPLATE_SID : null;
  const params = templateSid
    ? { to, from, contentSid: templateSid, contentVariables: JSON.stringify({ 1: body }) }
    : { to, from, body };

  await getTwilioClient().messages.create(params);
  console.log("Internal notification sent", { to, channel, template: Boolean(templateSid), preview: body.slice(0, 120) });
}

async function notifyInternalRecipients({ keyBase, recipients, twilioCallTo, body }) {
  if (!isInternalNotificationsEnabled()) return;
  if (!body) return;

  const allRecipients = [...new Set([...(recipients || []), ...getTestRecipients()].map(normalizePhoneNumber))].filter(
    Boolean
  );
  if (allRecipients.length === 0) return;

  const jobs = allRecipients.map((recipient, index) => {
    const channel = getInternalChannel();
    const fromAddress = getInternalFromAddress(channel, twilioCallTo);
    if (!fromAddress) return null;

    const key = `${keyBase}-${index}-${recipient}-${channel}`;
    return sendInternalNotification({
      key,
      to: asChannelAddress(channel, recipient),
      from: fromAddress,
      channel,
      body,
    });
  });

  await Promise.all(jobs);
}

module.exports = {
  getTwilioClient,
  markMessageSent,
  getBookingInternalRecipients,
  getLateRecipients,
  isInternalNotificationsEnabled,
  getInternalChannel,
  normalizePhoneNumber,
  asChannelAddress,
  getInternalFromAddress,
  getTestRecipients,
  notifyInternalRecipients,
};
