// Jednorazowe czyszczenie /admin/calls i /admin/sms z ruchu testowego/przedwdrożeniowego —
// od Krzysztofa, 24.09.2026: pierwszy prawdziwy dzień produkcji to 22.09.2026, więc wszystko
// sprzed tej daty (włącznie z 21.09.2026) to testy, demo i replaye, nie prawdziwe rozmowy klientów.
// callback_requests (/admin/callbacks) celowo NIE jest tu ruszane — nie było o to proszone.
//
// Uruchomienie na produkcji (DATA_DIR musi wskazywać na wolumen Railway, nie lokalny katalog):
//   railway ssh -- node scripts/purge_pre_launch_data.js
const { deleteCallTurnsBefore, deleteSmsMessagesBefore } = require("../src/services/callLog");

const CUTOFF_ISO = "2026-09-22T00:00:00.000Z";

const deletedCallTurns = deleteCallTurnsBefore(CUTOFF_ISO);
const deletedSmsMessages = deleteSmsMessagesBefore(CUTOFF_ISO);

console.log(`Usunięto wpisy sprzed ${CUTOFF_ISO}:`);
console.log(`  call_turns:    ${deletedCallTurns}`);
console.log(`  sms_messages:  ${deletedSmsMessages}`);
