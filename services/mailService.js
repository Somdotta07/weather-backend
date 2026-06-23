import dotenv from "dotenv";
dotenv.config();

import nodemailer from "nodemailer";

console.log("SMTP HOST:", process.env.BREVO_SMTP_HOST);
console.log("SMTP USER:", process.env.BREVO_SMTP_USER);
console.log("MAIL FROM:", process.env.MAIL_FROM);

const transporter = nodemailer.createTransport({
  host: process.env.BREVO_SMTP_HOST,
  port: Number(process.env.BREVO_SMTP_PORT || 587),
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_PASS,
  },
});

export async function sendPasswordResetEmail({ to, resetUrl }) {
  return transporter.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: "Reset your Malta Weather password",
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2>Reset your password</h2>
        <p>You requested to reset your Malta Weather password.</p>
        <p>This link will expire in 15 minutes.</p>
        <p>
          <a href="${resetUrl}" style="background:#3498db;color:#fff;padding:12px 18px;border-radius:24px;text-decoration:none;display:inline-block;">
            ${resetUrl}
          </a>
        </p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `,
  });
}