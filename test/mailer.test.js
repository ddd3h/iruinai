const test = require('node:test');
const assert = require('node:assert/strict');

test('SMTP_HOST 未設定ならコンソールに出す', async () => {
  delete process.env.SMTP_HOST;
  const { sendMail, mailMode } = require('../lib/mailer');
  assert.equal(mailMode(), 'console');
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await sendMail({ to: 'a@example.com', subject: '件名', text: '本文1\n本文2' });
  } finally {
    console.log = orig;
  }
  assert.equal(lines.join('\n'), '[mail] to=a@example.com subject=件名\n本文1\n本文2\n[/mail]');
});
