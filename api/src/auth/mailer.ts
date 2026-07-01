import nodemailer from 'nodemailer';
import { getWebOrigin } from './config';

function getTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const from = process.env.SMTP_FROM ?? 'Dental Receptionist <no-reply@example.com>';
  const transport = getTransport();

  if (!transport) {
    console.warn(`SMTP not configured. Email "${subject}" for ${to}:\n${text}`);
    return;
  }

  await transport.sendMail({ from, to, subject, text });
}

export async function sendInviteEmail(email: string, token: string): Promise<void> {
  const url = `${getWebOrigin()}/accept-invite?token=${encodeURIComponent(token)}`;
  await sendMail(
    email,
    'You have been invited to Dental Receptionist',
    `You have been invited to Dental Receptionist.\n\nAccept your invite here:\n${url}\n\nThis link expires soon.`
  );
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const url = `${getWebOrigin()}/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail(
    email,
    'Reset your Dental Receptionist password',
    `Reset your password here:\n${url}\n\nIf you did not request this, you can ignore this email.`
  );
}

export async function sendVerifyEmail(email: string, token: string): Promise<void> {
  const url = `${getWebOrigin()}/verify-email?token=${encodeURIComponent(token)}`;
  await sendMail(
    email,
    'Verify your Dental Receptionist email',
    `Verify your email here:\n${url}\n\nIf you did not create this account, you can ignore this email.`
  );
}
