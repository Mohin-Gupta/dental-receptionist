import nodemailer from 'nodemailer';
import { getWebOrigin } from './config';

function primaryWebOrigin(): string {
  const origin = getWebOrigin().split(',')[0]?.trim();
  if (!origin) throw new Error('WEB_ORIGIN is not configured');
  return origin.replace(/\/$/, '');
}

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
    requireTLS: port !== 465,
    auth: { user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

function getResendApiKey(): string | undefined {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY;

  // Backward-compatible migration path for deployments that already use a
  // Resend API key as their SMTP password.
  if (process.env.SMTP_HOST === 'smtp.resend.com') return process.env.SMTP_PASS;

  return undefined;
}

async function sendWithResendApi(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  text: string
): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const error = new Error('Resend API rejected the email delivery request') as Error & {
      code: string;
      responseCode: number;
    };
    error.code = `RESEND_API_${response.status}`;
    error.responseCode = response.status;
    throw error;
  }
}

async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const from = process.env.SMTP_FROM ?? 'Dental Receptionist <no-reply@example.com>';
  const resendApiKey = getResendApiKey();

  if (resendApiKey) {
    await sendWithResendApi(resendApiKey, from, to, subject, text);
    return;
  }

  const transport = getTransport();

  if (!transport) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP is not configured');
    }
    // Verification/reset tokens and patient email addresses must never enter
    // application logs, even during local development.
    console.warn('SMTP not configured; transactional email was not delivered', { subject });
    return;
  }

  await transport.sendMail({ from, to, subject, text });
}

export async function sendInviteEmail(email: string, token: string): Promise<void> {
  const url = `${primaryWebOrigin()}/accept-invite?token=${encodeURIComponent(token)}`;
  await sendMail(
    email,
    'You have been invited to Dental Receptionist',
    `You have been invited to Dental Receptionist.\n\nAccept your invite here:\n${url}\n\nThis link expires soon.`
  );
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const url = `${primaryWebOrigin()}/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail(
    email,
    'Reset your Dental Receptionist password',
    `Reset your password here:\n${url}\n\nIf you did not request this, you can ignore this email.`
  );
}

export async function sendVerifyEmail(email: string, token: string): Promise<void> {
  const url = `${primaryWebOrigin()}/verify-email?token=${encodeURIComponent(token)}`;
  await sendMail(
    email,
    'Verify your Dental Receptionist email',
    `Verify your email here:\n${url}\n\nIf you did not create this account, you can ignore this email.`
  );
}

export async function sendBudgetAlertEmail(input: {
  email: string;
  organizationName: string;
  clinicName: string | null;
  metric: string;
  threshold: number;
  dimension: string;
  actual: string;
  limit: string;
  currency: string | null;
  periodStart: Date;
  periodEnd: Date;
}): Promise<void> {
  const scope = input.clinicName ? `clinic ${input.clinicName}` : 'the whole organization';
  const unit = input.dimension === 'amount' && input.currency
    ? ` ${input.currency} minor units`
    : '';
  await sendMail(
    input.email,
    `${input.organizationName}: ${input.metric} usage reached ${input.threshold}%`,
    [
      `Usage alert for ${input.organizationName}.`,
      '',
      `Scope: ${scope}`,
      `Metric: ${input.metric}`,
      `Threshold: ${input.threshold}% of the configured ${input.dimension} limit`,
      `Current usage: ${input.actual}${unit}`,
      `Configured limit: ${input.limit}${unit}`,
      `Period: ${input.periodStart.toISOString()} to ${input.periodEnd.toISOString()}`,
      '',
      `Review usage and budgets in ${primaryWebOrigin()}/dashboard/billing.`,
    ].join('\n')
  );
}
