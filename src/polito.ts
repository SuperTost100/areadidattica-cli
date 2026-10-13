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
  // Epoch ms; no login attempts before this.
  loginPausedUntil: number;
  loginPauseReason: string | null;
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
        loginPausedUntil: Number(raw.loginPausedUntil) || 0,
        loginPauseReason: raw.loginPauseReason ?? null,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.#session = {
        clientId: randomUUID(),
        token: null,
        loggedInAt: null,
        loginPausedUntil: 0,
        loginPauseReason: null,
      };
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
    const label = `${method} ${apiPath}`;
    try {
      const stored = this.#session?.token ?? null;
      let token = stored ?? (await this.login());
      let res = await this.#send(method, apiPath, token);
      if (res.status === 401 && stored) {
        // Another request may already have replaced the expired token.
        const current = this.#session?.token;
        token = current && current !== stored ? current : await this.login();
        res = await this.#send(method, apiPath, token);
      }
      if (res.status === 401) {
        // PoliTO refused a token it just issued. Logging in again on every
        // request would only pile up sessions, so pause instead.
        await this.#pauseLogins(`${label} refused a new token with HTTP 401`);
      }
      const body = parseBody(res, label);
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
    const paused = this.#session?.loginPausedUntil ?? 0;
    if (Date.now() < paused) {
      throw new UpstreamError(
        `login paused until ${new Date(paused).toISOString()} (${this.#session?.loginPauseReason})`,
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
      await this.#pauseLogins(`login rejected with HTTP ${res.status}`);
    }
    const body = parseBody(res, 'login') as {
      data?: { token?: string; clientId?: string };
    };
    const token = body?.data?.token;
    if (!token) throw new UpstreamError('login: response has no token', res.status);

    this.#session = {
      clientId: body.data?.clientId || session.clientId,
      token,
      loggedInAt: new Date().toISOString(),
      loginPausedUntil: 0,
      loginPauseReason: null,
    };
    this.logins++;
    await this.#saveSession();
    return token;
  }

  // The pause is saved with the session, so a restart doesn't lift it.
  async #pauseLogins(reason: string): Promise<void> {
    this.#session = {
      ...this.#session!,
      token: null,
      loginPausedUntil: Date.now() + LOGIN_BACKOFF_MS,
      loginPauseReason: reason,
    };
    await this.#saveSession();
  }

  // A failed write keeps the session in memory only; the request still succeeds.
  async #saveSession(): Promise<void> {
    try {
      await mkdir(this.#opts.dataDir, { recursive: true });
      const tmp = `${this.#sessionFile}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#session, null, 2), { mode: 0o600 });
      await rename(tmp, this.#sessionFile);
    } catch (err) {
      console.error(`could not save ${this.#sessionFile}: ${(err as NodeJS.ErrnoException).code ?? err}`);
    }
  }

  // Every upstream call goes through this queue: one at a time, with a small
  // gap between calls. The body is read inside the queue too, so the next
  // call starts only after this one has fully finished.
  #send(
    method: string,
    apiPath: string,
    token: string | null,
    body?: unknown,
  ): Promise<RawResponse> {
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
        const res = await fetch(this.#opts.baseUrl + apiPath, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 20_000),
        });
        return { status: res.status, text: await res.text() };
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

interface RawResponse {
  status: number;
  text: string;
}

function parseBody({ status, text }: RawResponse, label: string): unknown {
  if (status < 200 || status > 299) {
    let detail = '';
    try {
      const err = JSON.parse(text);
      if (typeof err?.message === 'string') detail = `: ${err.message}`;
    } catch {
      // Not JSON: report the status alone.
    }
    throw new UpstreamError(`${label} failed with HTTP ${status}${detail}`, status);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(`${label} returned HTTP ${status} with a body that isn't JSON`, status);
  }
}
