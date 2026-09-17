import type { MiddlewareHandler } from 'hono';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function originIsLoopback(origin: string): boolean {
  try {
    return isLoopback(new URL(origin).hostname);
  } catch {
    // "null" (sandboxed frames, file://) and anything unparseable.
    return false;
  }
}

/**
 * Refuses requests that don't come from this machine's own pages. Binding to 127.0.0.1 is not enough:
 * any website the user visits can send a form POST here, and DNS rebinding lets a site read responses
 * by pointing its own hostname at 127.0.0.1. So the Host must be a loopback name, and a browser
 * request must come from a loopback origin.
 */
export function localOnly(): MiddlewareHandler {
  return async (c, next) => {
    // On Node the request URL is built from the Host header, so this is the Host the client sent.
    if (!isLoopback(new URL(c.req.url).hostname)) {
      return c.json({ error: 'Switchbox only accepts requests addressed to localhost' }, 403);
    }
    // Browsers always send Origin on cross-origin and non-GET requests. Tools like curl send none.
    const origin = c.req.header('origin');
    if (origin !== undefined && !originIsLoopback(origin)) {
      return c.json({ error: 'Requests from other sites are not allowed' }, 403);
    }
    // Covers cross-site GETs, which carry no Origin.
    if (c.req.header('sec-fetch-site') === 'cross-site') {
      return c.json({ error: 'Requests from other sites are not allowed' }, 403);
    }
    await next();
  };
}
