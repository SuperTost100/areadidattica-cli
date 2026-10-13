import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { PolitoClient } from './polito.ts';
import { UpstreamError } from './polito.ts';
import { BadRequest, type Service } from './service.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEADLINE_DAYS = 30;

export function createServer(opts: {
  service: Service;
  client: PolitoClient;
  apiToken: string;
  log?: (line: string) => void;
}): http.Server {
  const { service, client, log = () => {} } = opts;
  const expected = sha256(opts.apiToken);

  const authorized = (req: http.IncomingMessage) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    return !!m && timingSafeEqual(sha256(m[1]!), expected);
  };

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    };

    if (!authorized(req)) {
      res.setHeader('www-authenticate', 'Bearer');
      return send(401, { error: 'unauthorized' });
    }

    try {
      const path = url.pathname;
      const readMatch = /^\/items\/([^/]+)\/read$/.exec(path);

      if (path === '/health' && req.method === 'GET') {
        return send(200, {
          ok: client.lastError === null,
          loggedIn: client.loggedIn,
          lastError: client.lastError,
        });
      }
      if (path === '/items' && req.method === 'GET') {
        const unreadOnly = url.searchParams.get('unread') === 'true';
        return send(200, { items: await service.items({ unreadOnly }) });
      }
      if (readMatch && req.method === 'POST') {
        const id = decodeURIComponent(readMatch[1]!);
        await service.markRead(id);
        return send(200, { ok: true, id });
      }
      if (path === '/deadlines' && req.method === 'GET') {
        const from = url.searchParams.get('from') ?? romeDate(0);
        const to = url.searchParams.get('to') ?? romeDate(DEADLINE_DAYS);
        if (!DATE.test(from) || !DATE.test(to)) {
          throw new BadRequest('from and to must be YYYY-MM-DD');
        }
        return send(200, { deadlines: await service.deadlines(from, to) });
      }
      if (['/health', '/items', '/deadlines'].includes(path) || readMatch) {
        return send(405, { error: 'method not allowed' });
      }
      return send(404, { error: 'not found' });
    } catch (err) {
      if (err instanceof BadRequest || err instanceof URIError) {
        return send(400, { error: err.message });
      }
      if (err instanceof UpstreamError) {
        return send(err.status === 404 ? 404 : 502, { error: err.message });
      }
      log(`internal error: ${(err as Error).stack}`);
      return send(500, { error: 'internal error' });
    }
  });
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

// Today plus `days`, as a calendar date in Turin.
function romeDate(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d);
}
