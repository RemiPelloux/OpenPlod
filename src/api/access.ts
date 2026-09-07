import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const apiAccess: MiddlewareHandler = async (c, next) => {
  const tokens = [process.env.OPENPLOD_PAIRING_TOKEN, process.env.OPENPLOD_API_TOKEN].filter((value): value is string => Boolean(value));
  if (tokens.length) {
    const supplied = c.req.header('X-OpenPlod-Token') || '';
    if (!tokens.some(token => Buffer.byteLength(token) === Buffer.byteLength(supplied) && timingSafeEqual(Buffer.from(token), Buffer.from(supplied))))
      return c.json({ success: false, code: 'unauthorized', error: 'This device is not paired with OpenPlod.' }, 401);
  }
  c.header('Cache-Control', 'no-store');
  return next();
};
