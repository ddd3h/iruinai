let transport = null;

const smtpConfigured = () => !!process.env.SMTP_HOST;
const mailMode = () => (smtpConfigured() ? 'smtp' : 'console');

function getTransport() {
  if (transport) return transport;
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return transport;
}

// 失敗したら reject する。SMTP_HOST 未設定ならメールは送らず、コンソールに出す
async function sendMail({ to, subject, text }) {
  if (!smtpConfigured()) {
    console.log(`[mail] to=${to} subject=${subject}\n${text}\n[/mail]`);
    return;
  }
  await getTransport().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
}

module.exports = { sendMail, mailMode };
