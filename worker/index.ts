/**
 * Cloudflare Worker entry point. The static build in `dist/` is uploaded as
 * Workers Static Assets (see wrangler.jsonc); every request runs through this
 * Worker first so the response headers from ./headers.ts are applied.
 */
import { withResponseHeaders } from './headers';

interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const response = await env.ASSETS.fetch(request);
    return withResponseHeaders(new URL(request.url).pathname, response);
  },
} satisfies ExportedHandler<Env>;
