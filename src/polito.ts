import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

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
  // The account and API the token belongs to.
  username: string;
  baseUrl: string;
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
// A download reads the whole file inside the call, so it gets longer than a JSON call.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

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
      // Sessions saved before the account was recorded could belong to anyone,
      // so they don't count as this account's.
      const sameAccount = raw.username === this.#opts.username && raw.baseUrl === this.#opts.baseUrl;
      this.#session = {
        clientId: String(raw.clientId),
        username: this.#opts.username,
        baseUrl: this.#opts.baseUrl,
        // A token or a login pause from another account must not carry over:
        // a write would otherwise land on the account the token belongs to.
        token: sameAccount ? (raw.token ?? null) : null,
        loggedInAt: sameAccount ? (raw.loggedInAt ?? null) : null,
        loginPausedUntil: sameAccount ? Number(raw.loginPausedUntil) || 0 : 0,
        loginPauseReason: sameAccount ? (raw.loginPauseReason ?? null) : null,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.#session = {
        clientId: randomUUID(),
        username: this.#opts.username,
        baseUrl: this.#opts.baseUrl,
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

  // Sends an authenticated request and returns the parsed JSON body.
  async request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const label = `${method} ${apiPath}`;
    return this.#tracked(async () => {
      const res = await this.#authed(method, apiPath, body, readText);
      return parseBody(res, label) as T;
    });
  }

  // Downloads a file into `dest`, following PoliTO's redirect to the file.
  // Stops and deletes the partial file once it passes `maxBytes`.
  async download(apiPath: string, dest: string, maxBytes: number): Promise<{ bytes: number }> {
    const label = `GET ${apiPath}`;
    return this.#tracked(async () => {
      // Hidden and unique: safeSegment strips leading dots, so no course file
      // can have this name, and two runs never share one. It's created with
      // 'wx', so it never writes through a file or symlink already there.
      const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${randomUUID()}.part`);
      let bytes = 0;
      const res = await this.#authed('GET', apiPath, undefined, async (r) => {
        if (r.status < 200 || r.status > 299 || !r.body) return readCapped(r, ERROR_BODY_MAX);
        const declared = Number(r.headers.get('content-length'));
        if (declared > maxBytes) {
          await r.body.cancel();
          throw new TooLarge(label, maxBytes);
        }
        await mkdir(path.dirname(dest), { recursive: true });
        const limit = new Transform({
          transform(chunk: Buffer, _enc, done) {
            bytes += chunk.length;
            done(bytes > maxBytes ? new TooLarge(label, maxBytes, bytes) : null, chunk);
          },
        });
        try {
          await pipeline(Readable.fromWeb(r.body as WebReadableStream), limit, createWriteStream(tmp, { mode: 0o600, flags: 'wx' }));
        } catch (err) {
          await rm(tmp, { force: true });
          if (err instanceof TooLarge) throw err;
          throw new DownloadFailed(`${label}: ${(err as Error).message}`, bytes);
        }
        return { status: r.status, text: '' };
      }, DOWNLOAD_TIMEOUT_MS);
      // Raises for error statuses; a successful download has no body to parse.
      parseBody(res, label);
      try {
        await rename(tmp, dest);
      } catch (err) {
        await rm(tmp, { force: true });
        throw new DownloadFailed(`could not save ${dest}: ${(err as NodeJS.ErrnoException).code ?? err}`, bytes);
      }
      return { bytes };
    });
  }

  // Records the outcome in lastError, which /health and `status` report.
  async #tracked<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.lastError = null;
      return result;
    } catch (err) {
      if (!(err instanceof TooLarge)) this.lastError = (err as Error).message;
      throw err;
    }
  }

  // Logs in when there is no token yet, and logs in again once if PoliTO
  // answers 401.
  async #authed(
    method: string,
    apiPath: string,
    body: unknown,
    read: (res: Response) => Promise<RawResponse>,
    timeoutMs?: number,
  ): Promise<RawResponse> {
    const label = `${method} ${apiPath}`;
    const stored = this.#session?.token ?? null;
    let token = stored ?? (await this.login());
    let res = await this.#send(method, apiPath, token, body, read, timeoutMs);
    if (res.status === 401 && stored) {
      // Another request may already have replaced the expired token.
      const current = this.#session?.token;
      token = current && current !== stored ? current : await this.login();
      res = await this.#send(method, apiPath, token, body, read, timeoutMs);
    }
    if (res.status === 401) {
      // PoliTO refused a token it just issued. Logging in again on every
      // request would only pile up sessions, so pause instead.
      await this.#pauseLogins(`${label} refused a new token with HTTP 401`);
    }
    return res;
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
    }, readText);
    if (res.status >= 400 && res.status < 500) {
      await this.#pauseLogins(`login rejected with HTTP ${res.status}`);
    }
    const body = parseBody(res, 'login') as {
      data?: { token?: string; clientId?: string };
    };
    const token = body?.data?.token;
    if (!token) throw new UpstreamError('login: response has no token', res.status);

    this.#session = {
      ...session,
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
      await mkdir(this.#opts.dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.#sessionFile}.${randomUUID()}.tmp`;
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
    body: unknown,
    read: (res: Response) => Promise<RawResponse>,
    timeoutMs = this.#opts.timeoutMs ?? 20_000,
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
          signal: AbortSignal.timeout(timeoutMs),
        });
        return await read(res);
      } catch (err) {
        if (err instanceof UpstreamError || err instanceof TooLarge) throw err;
        const label = apiPath === '/auth/login' ? 'login' : `${method} ${apiPath}`;
        // fetch says only "fetch failed"; the cause says why (ECONNREFUSED, ENOTFOUND, a timeout).
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        const why = cause ? ` (${cause.code ?? cause.message})` : '';
        throw new UpstreamError(`${label}: ${(err as Error).message}${why}`, 0);
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

const readText = async (res: Response): Promise<RawResponse> => ({ status: res.status, text: await res.text() });

// An error answer to a download only needs its message, and the file host
// isn't bound to keep it short.
const ERROR_BODY_MAX = 64 * 1024;

async function readCapped(res: Response, max: number): Promise<RawResponse> {
  if (!res.body) return { status: res.status, text: '' };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel();
  return { status: res.status, text: Buffer.concat(chunks).subarray(0, max).toString('utf8') };
}

// A download that broke after some bytes had already arrived.
export class DownloadFailed extends UpstreamError {
  transferred: number;
  constructor(message: string, transferred: number) {
    super(message, 0);
    this.transferred = transferred;
  }
}

// A download bigger than the caller allowed. Not an upstream failure, so it
// doesn't set lastError.
export class TooLarge extends Error {
  // Bytes already received when the download stopped.
  transferred: number;
  constructor(label: string, maxBytes: number, transferred = 0) {
    super(`${label}: file is larger than ${Math.round(maxBytes / 1e6)} MB`);
    this.transferred = transferred;
  }
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
