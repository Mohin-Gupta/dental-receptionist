import type { CookieOptions } from 'express';

const isProduction = process.env.NODE_ENV === 'production';

export const SESSION_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ?? (isProduction ? '__Host-dr_session' : 'dr_session');

export const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 14);
export const INVITE_TTL_HOURS = Number(process.env.INVITE_TTL_HOURS ?? 72);
export const PASSWORD_RESET_TTL_MINUTES = Number(process.env.PASSWORD_RESET_TTL_MINUTES ?? 30);
export const EMAIL_VERIFY_TTL_HOURS = Number(process.env.EMAIL_VERIFY_TTL_HOURS ?? 24);

export function sessionCookieOptions(expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction || SESSION_COOKIE_NAME.startsWith('__Host-'),
    sameSite: 'lax',
    path: '/',
    expires,
  };
}

export function clearSessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction || SESSION_COOKIE_NAME.startsWith('__Host-'),
    sameSite: 'lax',
    path: '/',
    expires: new Date(0),
  };
}

export function getWebOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://localhost:3000';
}
