require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const voiceRouter = require("./src/routes/voice");
const adminRouter = require("./src/routes/admin");
const smsRouter = require("./src/routes/sms");

// Błąd w jednej rozmowie nie może ubić serwera obsługującego wszystkie pozostałe połączenia —
// logujemy i lecimy dalej zamiast pozwolić Node ubić cały proces.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

const app  = express();
const PORT = process.env.PORT || 3000;

// Twilio wysyła dane jako application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Logowanie każdego requestu
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`, req.body);
  next();
});

// Trasy
app.use("/voice", voiceRouter);
app.use("/sms", smsRouter);
app.use("/admin", adminRouter);

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Siatka bezpieczeństwa: jeśli coś w trasie /voice/* rzuci nieoczekiwany błąd, dzwoniący ma dostać
// grzeczny komunikat głosowy zamiast surowego błędu (który Twilio nie umie odczytać jako TwiML).
app.use((err, req, res, _next) => {
  console.error("Unhandled route error:", err);

  if (req.path.startsWith("/voice/")) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(
      { voice: process.env.TTS_VOICE || "Polly.Jacek", language: "pl-PL" },
      "Przepraszamy, wystąpił błąd techniczny. Zadzwoń proszę ponownie za chwilę."
    );
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, () => {
  console.log(`🟢 Barber Bot działa na porcie ${PORT}`);
  console.log(`   Webhook URL: ${process.env.BASE_URL}/voice/incoming`);
});
