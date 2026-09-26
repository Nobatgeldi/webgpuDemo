import { describe, expect, it } from 'vitest';
import {
  CONTENT_SECURITY_POLICY,
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  cacheControlFor,
  withResponseHeaders,
} from '../worker/headers';

describe('cacheControlFor', () => {
  it('caches hashed build output forever', () => {
    expect(cacheControlFor('/assets/index-BdF3x9aQ.js')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cacheControlFor('/assets/index-BdF3x9aQ.js.map')).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('revalidates the entry page and other paths', () => {
    expect(cacheControlFor('/')).toBe(REVALIDATE_CACHE_CONTROL);
    expect(cacheControlFor('/index.html')).toBe(REVALIDATE_CACHE_CONTROL);
    expect(cacheControlFor('/assetsx/a.js')).toBe(REVALIDATE_CACHE_CONTROL);
  });
});

describe('withResponseHeaders', () => {
  it('adds security and cache headers while keeping the original ones', async () => {
    const original = new Response('<!doctype html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html', ETag: '"abc"', 'Cache-Control': 'no-store' },
    });
    const response = withResponseHeaders('/', original);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    expect(response.headers.get('ETag')).toBe('"abc"');
    expect(response.headers.get('Cache-Control')).toBe(REVALIDATE_CACHE_CONTROL);
    expect(response.headers.get('Content-Security-Policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await response.text()).toBe('<!doctype html>');
  });

  it('applies the immutable policy to not-modified hashed assets', () => {
    const response = withResponseHeaders('/assets/app-1234.css', new Response(null, { status: 304 }));
    expect(response.status).toBe(304);
    expect(response.headers.get('Cache-Control')).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('leaves caching of error responses untouched', () => {
    const response = withResponseHeaders('/assets/missing.js', new Response('Not Found', { status: 404 }));
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toBe(CONTENT_SECURITY_POLICY);
  });
});
