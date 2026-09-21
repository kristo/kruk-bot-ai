// Simple script to send a test SMS via Twilio.
// Usage (example):
// TWILIO_ACCOUNT_SID=ACxxx TWILIO_AUTH_TOKEN=yyy TWILIO_FROM=+123456789 node scripts/send_test_sms.js

const twilio = require('twilio');

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const from = process.env.TWILIO_FROM;
const to = process.env.TWILIO_TO || '+48 666 241 442';
const body = process.env.TWILIO_TEST_BODY || 'Test SMS z Kruk Barbershop — zgłoszenie spóźnienia (test).';

if (!sid || !token || !from) {
  console.error('Brak wymaganych zmiennych środowiskowych. Ustaw TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN i TWILIO_FROM.');
  process.exit(1);
}

const client = twilio(sid, token);

client.messages.create({ to, from, body })
  .then((msg) => {
    console.log('Wysłano testowy SMS. Message SID:', msg.sid);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Błąd wysyłki SMS:', err.message || err);
    process.exit(2);
  });
