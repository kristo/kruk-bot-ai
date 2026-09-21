/**
 * SMS-y przychodzące na numer bota — od Krzysztofa, 17.09.2026.
 *
 * Do tej pory numer bota miał w Twilio ustawiony webhook na demo.twilio.com, więc klient, który
 * odpisał na SMS-a z linkiem do Booksy, dostawał automatyczną odpowiedź demonstracyjną Twilio,
 * a jego wiadomość nie docierała do nikogo. Tutaj zapisujemy ją trwale, dajemy znać zespołowi
 * i potwierdzamy klientowi odbiór — a odpowiedzieć można z panelu (/admin/sms).
 */
const express = require("express");
const twilio = require("twilio");
const { logSmsMessage } = require("../services/callLog");
const { notifyInternalRecipients, getBookingInternalRecipients } = require("../services/notify");

const router = express.Router();

// Ta sama zasada co w voice.js: w środowisku deweloperskim nie mamy podpisu Twilio.
// req.body bywa undefined przy żądaniu bez treści — SDK Twilio robi na tym Object.keys
// i rzuca TypeError, przez co zamiast 403 wracał 200 (zaobserwowane na produkcji 15.09.2026).
function validateTwilioRequest(req) {
  if (process.env.NODE_ENV === "development") return true;

  const signature = req.headers["x-twilio-signature"];
  const url = `${process.env.BASE_URL}${req.originalUrl}`;
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body || {});
}

const AUTO_REPLY =
  "Dziękujemy za wiadomość! Przekazaliśmy ją do zespołu Kruk Barbershop — odezwiemy się najszybciej, jak to możliwe.";

router.post("/incoming", async (req, res) => {
  if (!validateTwilioRequest(req)) {
    return res.status(403).send("Forbidden");
  }

  const from = req.body?.From;
  const to = req.body?.To;
  const body = (req.body?.Body || "").trim();
  const messageSid = req.body?.MessageSid || req.body?.SmsSid;

  logSmsMessage({
    direction: "in",
    clientPhone: from,
    body,
    twilioSid: messageSid,
    // MessageSid jest unikalny dla wiadomości, więc powtórzony webhook nie zrobi drugiego wpisu.
    dedupeKey: messageSid ? `sms-in-${messageSid}` : null,
  });

  // Odpowiedź dla klienta leci od razu w TwiML — nie czekamy na powiadomienie zespołu, żeby
  // ewentualna awaria po naszej stronie nie zablokowała potwierdzenia odbioru.
  const twiml = new twilio.twiml.MessagingResponse();
  if (process.env.SEND_SMS_AUTO_REPLY !== "false") {
    twiml.message(AUTO_REPLY);
  }
  res.type("text/xml").send(twiml.toString());

  try {
    await notifyInternalRecipients({
      keyBase: `sms-${messageSid || from}`,
      recipients: getBookingInternalRecipients(),
      twilioCallTo: to,
      body: `[SMS] Od ${from || "nieznany numer"}: ${body || "(pusta wiadomość)"}`,
    });
  } catch (err) {
    console.error("SMS notification error:", err.message || err);
  }
});

module.exports = router;
