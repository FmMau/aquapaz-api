const nodemailer = require('nodemailer');
function createMailer(env = process.env) {
  const ready = () => !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD && env.AUTH_MAIL_FROM && env.JWT_SECRET);
  let transport;
  return {
    ready,
    async sendCode(email, code) {
      if (!ready()) throw new Error('Mail unavailable');
      transport ||= nodemailer.createTransport({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true',
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, tls: { rejectUnauthorized: true } });
      await transport.sendMail({ from: env.AUTH_MAIL_FROM, to: email, subject: 'Recupera tu contraseña de AquaPaz',
        text: `Tu código de recuperación de AquaPaz es: ${code}\n\nCaduca en 15 minutos y admite hasta cinco intentos. Si no solicitaste este cambio, ignora este correo. Nunca compartas este código.` });
    },
  };
}
module.exports = { createMailer };
