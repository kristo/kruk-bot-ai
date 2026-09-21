// Minimalna kopia okablowania z index.js, żeby testy integracyjne mogły odpalić prawdziwy
// serwer HTTP bez efektu ubocznego app.listen() w index.js (który nie da się czysto zamknąć).
require("dotenv").config();

const express = require("express");
const voiceRouter = require("../../src/routes/voice");
const adminRouter = require("../../src/routes/admin");
const smsRouter = require("../../src/routes/sms");

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use("/voice", voiceRouter);
  app.use("/sms", smsRouter);
  app.use("/admin", adminRouter);
  return app;
}

// Startuje serwer na losowym wolnym porcie (0) i zwraca base URL + funkcję do zamknięcia.
function startTestServer() {
  const app = buildApp();
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

module.exports = { buildApp, startTestServer };
