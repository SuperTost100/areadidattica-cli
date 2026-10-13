import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class UpstreamError extends Error {
  // Upstream HTTP status, or 0 when the request never got a response.
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

interface Session {
  clientId: string;
  token: string | null;
  loggedInAt: string | null;
}

export interface PolitoClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  dataDir: string;
  appVersion: string;
  buildNumber: string;
  // Minimum pause between two upstream calls.
  gapMs?: number;
  timeoutMs?: number;
}

// After a rejected login, wait this long before trying again so a wrong
// password can't hammer the PoliTO login and lock the account.
const LOGIN_BACKOFF_MS = 5 * 60 * 1000;

export class PolitoClient {
  lastError: string | null = null;
  logins = 0;

  #opts: PolitoClientOptions;
  #sessionFile: string;
  #session: Session | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #lastCallAt = 0;
  #loginPromise: Promise<string> | null = null;
  #loginBlockedUntil = 0;
  #loginRejection = '';

  constructor(opts: PolitoClientOptions) {
    this.#opts = opts;
    this.#sessionFile = path.join(opts.dataDir, 'session.json');
  }

  get loggedIn(): boolean {
    return !!this.#session?.token;
  }

  // Loads the stored session, if any. Call once at startup.
  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.#sessionFile, 'utf8'));
      this.#session = {
        clientId: String(raw.clientId),
        token: raw.token ?? null,
        loggedInAt: raw.loggedInAt ?? null,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.#session = { clientId: randomUUID(), token: null, loggedInAt: null };
    }
  }

  async get<T>(apiPath: string): Promise<T> {
    return this.request<T>('GET', apiPath);
  }

  async put<T>(apiPath: string): Promise<T> {
    return this.request<T>('PUT', apiPath);
  }

  // Sends an authenticated request. Logs in when there is no token yet, and
  // logs in again once if PoliTO answers 401.
  async request<T>(method: string, apiPath: string): Promise<T> {
    try {
      let token = this.#session?.token ?? (await this.login());
      let res = await this.#send(method, apiPath, token);
      if (res.status === 401) {
        // Another request may already have replaced the expired token.
        token = this.#session?.token && this.#session.token !== token
          ? this.#session.token
          : await this.login();
        res = await this.#send(method, apiPath, token);
      }
      const body = await parseBody(res, `${method} ${apiPath}`);
      this.lastError = null;
      return body as T;
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    }
  }

  // Logs in and stores the token. Concurrent callers share one login.
  login(): Promise<string> {
    this.#loginPromise ??= this.#login().finally(() => {
      this.#loginPromise = null;
    });
    return this.#loginPromise;
  }

  async #login(): Promise<string> {
    if (Date.now() < this.#loginBlockedUntil) {
      throw new UpstreamError(
        `login paused until ${new Date(this.#loginBlockedUntil).toISOString()} after a rejected login (${this.#loginRejection})`,
        0,
      );
    }
    const session = this.#session!;
    const o = this.#opts;
    const res = await this.#send('POST', '/auth/login', null, {
      loginType: 'basic',
      username: o.username,
      password: o.password,
      preferences: { language: 'it' },
      // Same shape the official app sends. No fcmRegistrationToken, so push
      // notifications keep going to the phone only.
      client: {
        name: 'students-app',
        id: session.clientId,
        appVersion: o.appVersion,
        buildNumber: o.buildNumber,
      },
      device: {
        name: 'areadidattica',
        platform: 'linux',
        version: process.versions.node,
        model: 'server',
        manufacturer: 'self-hosted',
        toothPicCompatible: false,
      },
    });
    if (res.status >= 400 && res.status < 500) {
      this.#loginBlockedUntil = Date.now() + LOGIN_BACKOFF_MS;
      this.#loginRejection = `HTTP ${res.status}`;
    }
    const body = (await parseBody(res, 'login')) as {
      data?: { token?: string; clientId?: string };
    };
    const token = body?.data?.token;
    if (!token) throw new UpstreamError('login: response has no token', res.status);

    this.#session = {
      clientId: body.data?.clientId || session.clientId,
      token,
      loggedInAt: new Date().toISOString(),
    };
    this.logins++;
    await this.#saveSession();
    return token;
  }

  async #saveSession(): Promise<void> {
    await mkdir(this.#opts.dataDir, { recursive: true });
    const tmp = `${this.#sessionFile}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#session, null, 2), { mode: 0o600 });
    await rename(tmp, this.#sessionFile);
  }

  // Every upstream call goes through this queue: one at a time, with a small
  // gap between calls.
  #send(
    method: string,
    apiPath: string,
    token: string | null,
    body?: unknown,
  ): Promise<Response> {
    const run = async () => {
      const wait = this.#lastCallAt + (this.#opts.gapMs ?? 0) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const headers: Record<string, string> = {
        // Mark-read answers 204 with no body; a strict JSON-only Accept gets 406.
        accept: 'application/json, */*;q=0.1',
        'accept-language': 'it',
      };
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      try {
        return await fetch(this.#opts.baseUrl + apiPath, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 20_000),
        });
      } catch (err) {
        const label = apiPath === '/auth/login' ? 'login' : `${method} ${apiPath}`;
        throw new UpstreamError(`${label}: ${(err as Error).message}`, 0);
      } finally {
        this.#lastCallAt = Date.now();
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }
}

async function parseBody(res: Response, label: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    let detail = '';
    try {
      const err = JSON.parse(text);
      if (typeof err?.message === 'string') detail = `: ${err.message}`;
    } catch {
      // Not JSON: report the status alone.
    }
    throw new UpstreamError(`${label} failed with HTTP ${res.status}${detail}`, res.status);
  }
  return text ? JSON.parse(text) : null;
}
