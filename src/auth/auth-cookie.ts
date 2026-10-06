import type { Request, Response } from 'express';

export const AUTH_COOKIE = 'wr_admin_session';

export function sessionHours() {
  const raw = Number(process.env.AUTH_SESSION_HOURS ?? 8);
  return Number.isFinite(raw) && raw > 0 ? raw : 8;
}

export function sessionMaxAgeMs() {
  return sessionHours() * 60 * 60 * 1000;
}

function cookieSecure(req: Request) {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string') return proto.split(',')[0]?.trim() === 'https';
  if (req.secure) return true;
  return (process.env.WEB_ORIGIN ?? '')
    .split(',')
    .map((item) => item.trim())
    .some((origin) => origin.startsWith('https://'));
}

function cookieOptions(req: Request) {
  return {
    httpOnly: true,
    secure: cookieSecure(req),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: sessionMaxAgeMs(),
  };
}

export function setAuthCookie(req: Request, res: Response, token: string) {
  res.cookie(AUTH_COOKIE, token, cookieOptions(req));
}

export function clearAuthCookie(req: Request, res: Response) {
  res.clearCookie(AUTH_COOKIE, {
    httpOnly: true,
    secure: cookieSecure(req),
    sameSite: 'lax',
    path: '/',
  });
}
