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
const formatMoney = (amount, currency) =>
  new Intl.NumberFormat("en-MT", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);

export async function sendTrialEndingEmail({
  to,
  name,
  trialEnd,
  amount,
  currency,
  interval,
}) {
  const date = trialEnd.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const price = `${formatMoney(amount, currency)} ${interval === "year" ? "every 12 months" : "per month"}`;

  return transporter.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: "Your Malta Weather free trial ends soon",
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2>Your free trial ends on ${date}</h2>
        <p>Hi ${name || "there"},</p>
        <p>Thanks for trying Malta Weather Premium. Your free trial ends on
        <strong>${date}</strong>. After that your subscription continues at
        <strong>${price}</strong>, charged to the card you added, and renews
        automatically until you cancel.</p>
        <p>Don't want to continue? Open the app, go to
        <strong>Settings &rarr; Subscription</strong> and tap
        <strong>Cancel Premium</strong> before ${date}. You won't be charged.</p>
      </div>
    `,
  });
}
