import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PolitoClient } from '../src/polito.ts';
import { createServer } from '../src/server.ts';
import { Service } from '../src/service.ts';

export const PASSWORD = 'hunter2-secret-password';
export const API_TOKEN = 'test-token-0123456789abcdefghij';

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8');

export interface Recorded {
  method: string;
  path: string;
  auth: string | undefined;
  body: any;
}

// A stand-in for app.didattica.polito.it that answers from the fixtures.
export async function startFakePolito() {
  const state = {
    requests: [] as Recorded[],
    validTokens: new Set<string>(),
    tokenCounter: 0,
    inFlight: 0,
    maxInFlight: 0,
    // Path → status to return instead of the fixture, with an optional body.
    fail: new Map<string, number | { status: number; body: string }>(),
    loginStatus: 200,
    // Answer 401 to every token, even fresh ones.
    rejectTokens: false,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      // Hold each request briefly so overlapping calls would show up.
      await new Promise((r) => setTimeout(r, 5));
      state.inFlight--;

      const url = new URL(req.url!, 'http://x');
      const p = url.pathname.replace(/^\/api/, '');
      state.requests.push({
        method: req.method!,
        path: p + url.search,
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      });
      const json = (status: number, body?: string) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      };

      const failure = state.fail.get(p);
      if (typeof failure === 'number') return json(failure, '{"code":1,"message":"boom"}');
      if (failure) return json(failure.status, failure.body);
      if (p === '/auth/login' && req.method === 'POST') {
        if (state.loginStatus !== 200) {
          return json(state.loginStatus, '{"code":401,"message":"Credenziali non valide"}');
        }
        const token = `tok-${++state.tokenCounter}`;
        state.validTokens.add(token);
        const body = JSON.parse(fixture('login'));
        body.data.token = token;
        return json(200, JSON.stringify(body));
      }
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (!token || !state.validTokens.has(token) || state.rejectTokens) return json(401, '{"code":401,"message":"Unauthorized"}');

      const routes: Record<string, string> = {
        'GET /notifications': 'notifications',
        'GET /messages': 'messages',
        'GET /v2/courses': 'courses',
        'GET /deadlines': 'deadlines',
        'GET /courses/258674/notices': 'notices-258674',
        'GET /courses/261234/notices': 'notices-261234',
      };
      const name = routes[`${req.method} ${p}`];
      if (name) return json(200, fixture(name));
      if (req.method === 'PUT' && /^\/(notifications|messages)\/\d+\/read$/.test(p)) {
        res.writeHead(204).end();
        return;
      }
      json(404, '{"code":404,"message":"Not found"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}/api`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    count: (method: string, prefix: string) =>
      state.requests.filter((r) => r.method === method && r.path.startsWith(prefix)).length,
  };
}

// Starts our service against a fake PoliTO. Pass dataDir to reuse a session.
export async function startService(baseUrl: string, opts: { dataDir?: string; now?: () => number } = {}) {
  const dataDir = opts.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), 'areadidattica-')));
  const logs: string[] = [];
  const client = new PolitoClient({
    baseUrl,
    username: 's123456',
    password: PASSWORD,
    dataDir,
    appVersion: '1.6.2',
    buildNumber: '1060200',
    gapMs: 0,
  });
  await client.init();
  const service = new Service(client, { noticesTtlMs: 300_000, now: opts.now });
  const server = createServer({ service, client, apiToken: API_TOKEN, log: (l) => logs.push(l) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    client,
    dataDir,
    logs,
    call: async (method: string, p: string, token: string | null = API_TOKEN) => {
      const res = await fetch(base + p, {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      return { status: res.status, body: (await res.json()) as any };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}
