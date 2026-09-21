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

async function sendInternalNotification({ key, to, from, body }) {
  if (!to || !from || !body) return;
  if (!markMessageSent(key)) return;

  await getTwilioClient().messages.create({ to, from, body });
  console.log("Internal notification sent", { to, preview: body.slice(0, 120) });
}

async function notifyInternalRecipients({ keyBase, recipients, twilioCallTo, body }) {
  if (!isInternalNotificationsEnabled()) return;
  if (!body) return;

  const allRecipients = [...new Set([...(recipients || []), ...getTestRecipients()].map(normalizePhoneNumber))].filter(
    Boolean
  );
  if (allRecipients.length === 0) return;

  const channel = getInternalChannel();
  const fromAddress = getInternalFromAddress(channel, twilioCallTo);
  if (!fromAddress) return;

  const jobs = allRecipients.map((recipient, index) => {
    const key = `${keyBase}-${index}-${recipient}`;
    return sendInternalNotification({
      key,
      to: asChannelAddress(channel, recipient),
      from: fromAddress,
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
