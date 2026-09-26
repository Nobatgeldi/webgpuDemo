/**
 * Response header policy for the Cloudflare Worker that serves the production
 * build. Kept free of Workers-specific types so it can be unit tested in Node.
 */

/** Vite emits content-hashed file names under this prefix (`build.assetsDir`). */
const HASHED_ASSETS_PREFIX = '/assets/';

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/**
 * Everything is bundled and served from the same origin. `style-src` needs
 * 'unsafe-inline' because lil-gui injects its stylesheet as a <style> element,
 * `font-src data:` covers the icon font embedded in that stylesheet and
 * `img-src data:` covers the empty favicon in index.html.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export function cacheControlFor(pathname: string): string {
  return pathname.startsWith(HASHED_ASSETS_PREFIX) ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
}

/**
 * Returns a copy of `response` with the security headers applied. Successful
 * responses also get a cache policy: hashed build output is cached forever,
 * everything else (index.html) is revalidated on every load so a new deploy is
 * picked up immediately. Error responses keep whatever caching they came with.
 */
export function withResponseHeaders(pathname: string, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (response.status === 200 || response.status === 304) {
    headers.set('Cache-Control', cacheControlFor(pathname));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
