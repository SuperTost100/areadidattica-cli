import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { API_TOKEN, PASSWORD, startFakePolito, startService } from './helpers.ts';

type Fake = Awaited<ReturnType<typeof startFakePolito>>;
type Svc = Awaited<ReturnType<typeof startService>>;

describe('auth', () => {
  let fake: Fake;
  let svc: Svc;
  before(async () => {
    fake = await startFakePolito();
    svc = await startService(fake.baseUrl);
  });
  after(async () => {
    await svc.close();
    await svc.cleanup();
    await fake.close();
  });

  for (const [method, p] of [
    ['GET', '/health'],
    ['GET', '/items'],
    ['GET', '/deadlines'],
    ['POST', '/items/notification:901/read'],
  ] as const) {
    it(`rejects ${method} ${p} without the right bearer token`, async () => {
      assert.equal((await svc.call(method, p, null)).status, 401);
      assert.equal((await svc.call(method, p, 'wrong-token')).status, 401);
    });
  }

  it('makes no upstream calls for rejected requests', () => {
    assert.equal(fake.state.requests.length, 0);
  });
});

describe('GET /items', () => {
  let fake: Fake;
  let svc: Svc;
  let now = Date.parse('2026-10-13T10:00:00Z');
  before(async () => {
    fake = await startFakePolito();
    svc = await startService(fake.baseUrl, { now: () => now });
  });
  after(async () => {
    await svc.close();
    await svc.cleanup();
    await fake.close();
  });

  it('returns avvisi and messages, newest first', async () => {
    const { status, body } = await svc.call('GET', '/items');
    assert.equal(status, 200);
    assert.deepEqual(
      body.items.map((i: any) => i.id),
      ['message:7001', 'notification:901', 'notification:902', 'notification:905', 'message:7002'],
    );
  });

  it('fills an avviso with the full notice text and the course name', async () => {
    const { body } = await svc.call('GET', '/items');
    const avviso = body.items.find((i: any) => i.id === 'notification:901');
    assert.deepEqual(avviso, {
      id: 'notification:901',
      kind: 'avviso',
      course: 'System and device programming',
      title: 'Nuovo avviso da System and device programming',
      text:
        'Gentili studenti,\n\n' +
        'la lezione di mercoledì 14 ottobre è spostata in aula 7T, dalle 13:00 alle 14:30.\n' +
        'Il materiale è su questa pagina (https://example.polito.it/sdp).\n\n' +
        'Cordiali saluti,\nStefano Quer',
      sentAt: '2026-10-12T08:01:00Z',
      isRead: false,
      urgent: false,
      sourceUrl: null,
    });
  });

  it('matches a notice by id when the scope carries one, using the module name', async () => {
    const { body } = await svc.call('GET', '/items');
    const avviso = body.items.find((i: any) => i.id === 'notification:902');
    assert.equal(avviso.course, 'Basi di dati');
    assert.equal(avviso.text, "L'esercitazione di venerdì è annullata.\n\n- recupero lunedì\n- aula 3I");
    assert.equal(avviso.isRead, true);
  });

  it('falls back to the notification text and title when the course is unknown', async () => {
    const { body } = await svc.call('GET', '/items');
    const avviso = body.items.find((i: any) => i.id === 'notification:905');
    assert.equal(avviso.course, 'Analisi matematica I');
    assert.equal(avviso.text, 'Avviso senza corso numerico');
  });

  it('marks emergency messages urgent and strips message HTML', async () => {
    const { body } = await svc.call('GET', '/items');
    const [emergency, personal] = ['message:7001', 'message:7002'].map((id) =>
      body.items.find((i: any) => i.id === id),
    );
    assert.equal(emergency.urgent, true);
    assert.equal(emergency.kind, 'message');
    assert.equal(emergency.course, null);
    assert.equal(personal.urgent, false);
    assert.equal(personal.text, 'Puoi venire a ritirare la tua smartcard presso la Segreteria Generale.');
  });

  it('skips non-notice notifications (files, message pushes)', async () => {
    const { body } = await svc.call('GET', '/items');
    const ids = body.items.map((i: any) => i.id);
    assert.ok(!ids.includes('notification:903'));
    assert.ok(!ids.includes('notification:904'));
  });

  it('filters to unread with ?unread=true', async () => {
    const { body } = await svc.call('GET', '/items?unread=true');
    assert.deepEqual(
      body.items.map((i: any) => i.id),
      ['message:7001', 'notification:901', 'notification:905'],
    );
  });

  it('logged in once and reused the token for every call', () => {
    assert.equal(fake.count('POST', '/auth/login'), 1);
    const authed = fake.state.requests.filter((r) => r.path !== '/auth/login');
    assert.ok(authed.every((r) => r.auth === 'Bearer tok-1'));
  });

  it('caches course notice lists and the course list', () => {
    assert.equal(fake.count('GET', '/courses/258674/notices'), 1);
    assert.equal(fake.count('GET', '/courses/261234/notices'), 1);
    assert.equal(fake.count('GET', '/v2/courses'), 1);
    // Shortcodes can't be fetched, so no call for 01RKCOV.
    assert.equal(fake.count('GET', '/courses/01RKCOV'), 0);
  });

  it('refetches notice lists after the cache expires', async () => {
    now += 301_000;
    await svc.call('GET', '/items');
    assert.equal(fake.count('GET', '/courses/258674/notices'), 2);
    assert.equal(fake.count('GET', '/v2/courses'), 1);
  });

  it('never has two upstream calls in flight, even under concurrent requests', async () => {
    now += 301_000;
    await Promise.all([1, 2, 3].map(() => svc.call('GET', '/items')));
    assert.equal(fake.state.maxInFlight, 1);
  });
});

describe('login and token reuse', () => {
  let fake: Fake;
  before(async () => {
    fake = await startFakePolito();
  });
  after(() => fake.close());

  it('sends the login body the official app sends, without a push token', async () => {
    const svc = await startService(fake.baseUrl);
    await svc.call('GET', '/items');
    const login = fake.state.requests.find((r) => r.path === '/auth/login')!;
    assert.equal(login.body.loginType, 'basic');
    assert.equal(login.body.username, 's123456');
    assert.deepEqual(login.body.preferences, { language: 'it' });
    assert.equal(login.body.client.name, 'students-app');
    assert.match(login.body.client.id, /^[0-9a-f-]{36}$/);
    assert.equal(login.body.client.fcmRegistrationToken, undefined);
    assert.equal(login.body.device.toothPicCompatible, false);
    await svc.close();
    await svc.cleanup();
  });

  it('stores the session with owner-only permissions and reuses it after a restart', async () => {
    fake.state.requests.length = 0;
    const first = await startService(fake.baseUrl);
    await first.call('GET', '/items');
    await first.close();

    const file = path.join(first.dataDir, 'session.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.clientId, '5a54f626-4b7e-488e-a0e3-300f54051510');
    assert.equal(JSON.stringify(saved).includes(PASSWORD), false);

    const second = await startService(fake.baseUrl, { dataDir: first.dataDir });
    assert.equal((await second.call('GET', '/health')).body.loggedIn, true);
    await second.call('GET', '/items');
    assert.equal(fake.count('POST', '/auth/login'), 1);
    await second.close();
    await second.cleanup();
  });

  it('logs in again once on 401 and retries the request', async () => {
    fake.state.requests.length = 0;
    const svc = await startService(fake.baseUrl);
    await svc.call('GET', '/items');
    fake.state.validTokens.clear(); // PoliTO expired the token

    const { status } = await svc.call('GET', '/items');
    assert.equal(status, 200);
    assert.equal(fake.count('POST', '/auth/login'), 2);
    const saved = JSON.parse(await readFile(path.join(svc.dataDir, 'session.json'), 'utf8'));
    assert.equal(saved.token, `tok-${fake.state.tokenCounter}`);
    await svc.close();
    await svc.cleanup();
  });

  it('reports a rejected login without leaking the password, and pauses retries', async () => {
    fake.state.requests.length = 0;
    fake.state.loginStatus = 401;
    const svc = await startService(fake.baseUrl);

    const first = await svc.call('GET', '/items');
    assert.equal(first.status, 502);
    assert.match(first.body.error, /login failed with HTTP 401/);

    const health = await svc.call('GET', '/health');
    assert.deepEqual(
      { ok: health.body.ok, loggedIn: health.body.loggedIn },
      { ok: false, loggedIn: false },
    );
    assert.match(health.body.lastError, /login failed with HTTP 401: Credenziali non valide/);

    const second = await svc.call('GET', '/items');
    assert.match(second.body.error, /login paused until .* \(login rejected with HTTP 401\)/);
    assert.equal(fake.count('POST', '/auth/login'), 1);

    const everything = JSON.stringify([first, health, second, svc.logs]);
    assert.equal(everything.includes(PASSWORD), false);
    assert.equal(everything.includes(API_TOKEN), false);
    fake.state.loginStatus = 200;
    await svc.close();
    await svc.cleanup();
  });
});

describe('login pause', () => {
  it('stops logging in when PoliTO refuses fresh tokens, also after a restart', async () => {
    const fake = await startFakePolito();
    fake.state.rejectTokens = true;
    const svc = await startService(fake.baseUrl);

    assert.equal((await svc.call('GET', '/items')).status, 502);
    assert.equal(fake.count('POST', '/auth/login'), 1);

    const again = await svc.call('GET', '/items');
    assert.equal(again.status, 502);
    assert.match(again.body.error, /login paused until .*refused a new token with HTTP 401/);
    await svc.close();

    const restarted = await startService(fake.baseUrl, { dataDir: svc.dataDir });
    assert.match((await restarted.call('GET', '/items')).body.error, /login paused/);
    assert.equal(fake.count('POST', '/auth/login'), 1);
    await restarted.close();
    await restarted.cleanup();
    await fake.close();
  });
});

describe('POST /items/{id}/read', () => {
  let fake: Fake;
  let svc: Svc;
  before(async () => {
    fake = await startFakePolito();
    svc = await startService(fake.baseUrl);
  });
  after(async () => {
    await svc.close();
    await svc.cleanup();
    await fake.close();
  });

  it('marks an avviso read on PoliTO', async () => {
    const { status, body } = await svc.call('POST', `/items/${encodeURIComponent('notification:901')}/read`);
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, id: 'notification:901' });
    assert.equal(fake.count('PUT', '/notifications/901/read'), 1);
  });

  it('marks a message read and clears its push notification', async () => {
    await svc.call('GET', '/items');
    const { status } = await svc.call('POST', '/items/message:7001/read');
    assert.equal(status, 200);
    assert.equal(fake.count('PUT', '/messages/7001/read'), 1);
    assert.equal(fake.count('PUT', '/notifications/904/read'), 1);
  });

  it('clears the push notification even without a prior GET /items', async () => {
    const fresh = await startService(fake.baseUrl);
    const before = fake.count('PUT', '/notifications/904/read');
    assert.equal((await fresh.call('POST', '/items/message:7001/read')).status, 200);
    assert.equal(fake.count('PUT', '/notifications/904/read'), before + 1);
    await fresh.close();
    await fresh.cleanup();
  });

  it('rejects unknown ids with 400', async () => {
    const { status } = await svc.call('POST', '/items/deadline:55/read');
    assert.equal(status, 400);
  });

  it('passes a PoliTO 404 through', async () => {
    fake.state.fail.set('/notifications/999/read', 404);
    const { status } = await svc.call('POST', '/items/notification:999/read');
    assert.equal(status, 404);
  });
});

describe('GET /deadlines', () => {
  let fake: Fake;
  let svc: Svc;
  before(async () => {
    fake = await startFakePolito();
    svc = await startService(fake.baseUrl);
  });
  after(async () => {
    await svc.close();
    await svc.cleanup();
    await fake.close();
  });

  it('returns normalized deadlines sorted by date', async () => {
    const { status, body } = await svc.call('GET', '/deadlines?from=2026-10-01&to=2026-12-31');
    assert.equal(status, 200);
    assert.deepEqual(body.deadlines[0], {
      id: 'deadline:55',
      title: "Termine per l'iscrizione e pagamento della prima rata",
      date: '2026-10-20',
      course: null,
      type: 'Iscrizioni e pagamento tasse',
      url: 'https://www.polito.it/tasse',
    });
    assert.match(body.deadlines[1].id, /^deadline:[0-9a-f]{12}$/);
    assert.ok(fake.state.requests.some((r) => r.path === '/deadlines?fromDate=2026-10-01&toDate=2026-12-31'));
  });

  it('gives deadlines without an upstream id the same id on every call', async () => {
    const a = await svc.call('GET', '/deadlines');
    const b = await svc.call('GET', '/deadlines');
    assert.equal(a.body.deadlines[1].id, b.body.deadlines[1].id);
  });

  it('rejects malformed dates', async () => {
    assert.equal((await svc.call('GET', '/deadlines?from=13/10/2026')).status, 400);
  });
});

describe('GET /health', () => {
  it('reports upstream errors and clears them after a success', async () => {
    const fake = await startFakePolito();
    const svc = await startService(fake.baseUrl);
    assert.deepEqual((await svc.call('GET', '/health')).body, { ok: true, loggedIn: false, lastError: null });

    fake.state.fail.set('/notifications', 500);
    assert.equal((await svc.call('GET', '/items')).status, 502);
    assert.deepEqual((await svc.call('GET', '/health')).body, {
      ok: false,
      loggedIn: true,
      lastError: 'GET /notifications failed with HTTP 500: boom',
    });

    fake.state.fail.set('/notifications', { status: 200, body: '<html>Manutenzione</html>' });
    const notJson = await svc.call('GET', '/items');
    assert.equal(notJson.status, 502);
    assert.match(notJson.body.error, /isn't JSON/);

    fake.state.fail.delete('/notifications');
    await svc.call('GET', '/items');
    assert.equal((await svc.call('GET', '/health')).body.ok, true);
    await svc.close();
    await svc.cleanup();
    await fake.close();
  });
});
