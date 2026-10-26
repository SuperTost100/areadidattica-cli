import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../src/cli.ts';
import { PASSWORD, startFakePolito } from './helpers.ts';

type Fake = Awaited<ReturnType<typeof startFakePolito>>;

describe('areadidattica command line', () => {
  let fake: Fake;
  let dir: string;
  let env: NodeJS.ProcessEnv;

  const cliEnv = async (e: NodeJS.ProcessEnv, ...argv: string[]) => {
    let out = '';
    let err = '';
    const code = await run(argv, { env: e, out: (t) => (out += t), err: (t) => (err += t) });
    const first = err ? JSON.parse(err.split('\n')[0]!) : {};
    const json = out.startsWith('[') || out.startsWith('{') ? JSON.parse(out) : undefined;
    return { code, json, out, err: first.error ?? first.warning ?? '' };
  };
  const cli = (...argv: string[]) => cliEnv(env, ...argv);

  before(async () => {
    fake = await startFakePolito();
    dir = await mkdtemp(path.join(os.tmpdir(), 'areadidattica-cli-'));
    env = {
      HOME: dir,
      POLITO_USERNAME: 's123456',
      POLITO_PASSWORD: PASSWORD,
      POLITO_BASE_URL: fake.baseUrl,
      UPSTREAM_GAP_MS: '0',
    };
  });
  after(async () => {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('prints help without credentials', async () => {
    const { code, out } = await cliEnv({ HOME: dir }, 'help');
    assert.equal(code, 0);
    assert.match(out, /download <course> <file-or-folder-id>/);
    assert.match(out, /grade-accept/);
  });

  it('reads the env file when the environment has no credentials', async () => {
    const file = path.join(dir, 'creds.env');
    await writeFile(file, `POLITO_USERNAME=s123456\nPOLITO_PASSWORD=${PASSWORD}\nPOLITO_BASE_URL=${fake.baseUrl}\n`);
    const { code, json } = await cliEnv({ HOME: dir, UPSTREAM_GAP_MS: '0', AREADIDATTICA_ENV_FILE: file }, 'status');
    assert.equal(code, 0);
    assert.equal(json.dataDir, path.join(dir, '.local', 'state', 'areadidattica'));
    assert.equal(json.writesAllowed, false);
  });

  it('lists items and keeps the session in the state folder', async () => {
    const { code, json } = await cli('items', '--unread');
    assert.equal(code, 0);
    assert.ok(json.length > 0);
    assert.ok(json.every((i: any) => !i.isRead));
    const session = await stat(path.join(dir, '.local', 'state', 'areadidattica', 'session.json'));
    assert.equal(session.mode & 0o777, 0o600);
  });

  it('drops the stored token when the configured account changes', async () => {
    const logins = () => fake.count('POST', '/auth/login');
    const before = logins();
    assert.equal((await cli('exams')).code, 0);
    assert.equal(logins(), before, 'same account reuses the token');

    assert.equal((await cliEnv({ ...env, POLITO_USERNAME: 's999999' }, 'exams')).code, 0);
    assert.equal(logins(), before + 1);
    assert.equal(fake.state.requests.findLast((r) => r.path === '/auth/login')!.body.username, 's999999');

    assert.equal((await cli('exams')).code, 0);
    assert.equal(logins(), before + 2, 'switching back logs in as the configured account again');
  });

  it('finds a course by id, shortcode or part of its name, and its modules', async () => {
    for (const q of ['258674', '01nyhov', 'device prog']) {
      const { json } = await cli('notices', q);
      assert.ok(json.length > 0, q);
      assert.ok(json.every((n: any) => !/<[a-z]/i.test(n.text)), 'notice text is plain');
    }
    assert.equal((await cli('notices', 'basi di dati')).code, 0);
    const none = await cli('notices', 'chimica');
    assert.equal(none.code, 2);
    assert.match(none.err, /no course matches "chimica".*System and device programming \(258674\)/);
  });

  it('lists course files flat, with their folders', async () => {
    const { code, json } = await cli('files', '01NYHOV');
    assert.equal(code, 0);
    assert.deepEqual(
      json.map((f: any) => [f.id, f.folder, f.name]),
      [
        ['34100002', 'Lezioni', 'L01 Introduzione.pdf'],
        ['34100004', 'Lezioni/Esercitazioni', 'E01 Processi.pdf'],
        ['34100006', '', '../../escape.txt'],
        ['34100007', '', 'Videolezione.mp4'],
      ],
    );
    assert.equal(json[0].course, 'System and device programming');
  });

  it('filters files by date and by name, across every course', async () => {
    // E01 was uploaded at 01:35 Rome time on 2026-10-16, which is still the 15th in UTC.
    const since = await cli('files', '--since', '2026-10-16');
    assert.deepEqual(since.json.map((f: any) => f.id), ['34100004', '34100006', '34100007']);
    const search = await cli('files', '--search', 'esercitazioni');
    assert.deepEqual(search.json.map((f: any) => f.id), ['34100004']);
    // The module of the integrated course has no files fixture, so PoliTO answers 404.
    assert.equal(search.code, 0);
    assert.match(search.err, /skipped Basi di dati \(261234\): .*HTTP 404/);
  });

  it('downloads a folder into course and folder paths, and skips unchanged files', async () => {
    const out = path.join(dir, 'dl');
    const first = await cli('download', '258674', '34100001', '--out', out);
    assert.equal(first.code, 0);
    const base = path.join(out, 'System and device programming (258674)', 'Lezioni');
    assert.deepEqual(
      first.json.downloaded.map((d: any) => [d.path, d.bytes]),
      [
        [path.join(base, 'L01 Introduzione.pdf'), 1500],
        [path.join(base, 'Esercitazioni', 'E01 Processi.pdf'), 1500],
      ],
    );
    assert.equal((await readFile(path.join(base, 'L01 Introduzione.pdf'))).length, 1500);
    assert.deepEqual(await readdir(base), ['Esercitazioni', 'L01 Introduzione.pdf']);

    const again = await cli('download', '258674', '34100002', '--out', out);
    assert.deepEqual(again.json.downloaded, []);
    assert.equal(again.json.skipped[0].reason, 'unchanged since the last download');

    const forced = await cli('download', '258674', '34100002', '--out', out, '--force');
    assert.equal(forced.json.downloaded.length, 1);
  });

  it('keeps a file named like a path inside the course folder', async () => {
    const out = path.join(dir, 'dl-escape');
    const { json } = await cli('download', '258674', '34100006', '--out', out);
    assert.equal(json.downloaded[0].path, path.join(out, 'System and device programming (258674)', '_.._escape.txt'));
  });

  it('skips files over the size limit before downloading them', async () => {
    const before = fake.count('GET', '/files-host/34100007');
    const { json } = await cli('download', '258674', '34100007', '--out', path.join(dir, 'dl-big'));
    assert.deepEqual(json.downloaded, []);
    assert.match(json.skipped[0].reason, /over the size limit/);
    assert.equal(fake.count('GET', '/files-host/34100007'), before);
  });

  for (const hideLength of [false, true]) {
    it(`stops a file bigger than its listing says, ${hideLength ? 'while streaming' : 'from its content-length'}`, async () => {
      fake.state.fileSizes.set('34100004', 3_000_000);
      fake.state.hideLength = hideLength;
      const out = path.join(dir, `dl-grow-${hideLength}`);
      const { json } = await cli('download', '258674', '34100004', '--out', out, '--max-mb', '2');
      fake.state.fileSizes.delete('34100004');
      fake.state.hideLength = false;
      assert.deepEqual(json.downloaded, []);
      assert.match(json.skipped[0].reason, /larger than 2 MB/);
      const folder = path.join(out, 'System and device programming (258674)', 'Lezioni', 'Esercitazioni');
      // No partial file is left behind.
      assert.deepEqual(await readdir(folder).catch(() => []), []);
    });
  }

  it('counts the bytes of a stopped download against the run limit', async () => {
    fake.state.fileSizes.set('34100002', 3_000_000);
    fake.state.fileSizes.set('34100004', 3_000_000);
    fake.state.hideLength = true;
    const { json } = await cli('download', '258674', '34100001', '--out', path.join(dir, 'dl-budget'), '--max-mb', '2');
    fake.state.fileSizes.clear();
    fake.state.hideLength = false;
    assert.deepEqual(json.downloaded, []);
    assert.match(json.skipped[0].reason, /larger than 2 MB/);
    // The first file used up the 2 MB, so the second isn't fetched at all.
    assert.match(json.skipped[1].reason, /over the size limit \(0 MB left/);
  });

  it('rejects an id that is not in the course', async () => {
    const { code, err } = await cli('download', '258674', '999');
    assert.equal(code, 2);
    assert.match(err, /no file or non-empty folder 999/);
  });

  it('refuses writes without --allow-writes and calls nothing on PoliTO', async () => {
    const before = fake.state.requests.length;
    for (const argv of [
      ['exam-book', '887981'],
      ['exam-cancel', '887981'],
      ['grade-accept', '654632'],
      ['grade-reject', '654632'],
      ['booking-create', '103051'],
      ['booking-cancel', '5'],
      ['api', 'POST', '/bookings'],
      ['api', 'delete', '/messages/7001'],
    ]) {
      const { code, err } = await cli(...argv);
      assert.equal(code, 2, argv.join(' '));
      assert.match(err, /only with --allow-writes/);
    }
    assert.equal(fake.state.requests.length, before);
  });

  it('books an exam with the shortcode PoliTO asks for when writes are allowed', async () => {
    const { code } = await cli('exam-book', '887981', '--allow-writes');
    assert.equal(code, 0);
    const booking = fake.state.requests.at(-1)!;
    assert.equal(booking.method, 'POST');
    assert.equal(booking.path, '/exams/887981/booking');
    assert.deepEqual(booking.body, { courseShortcode: '01NYHOV' });
  });

  it('passes GET calls through the api command', async () => {
    const { code, json } = await cli('api', 'GET', '/exams');
    assert.equal(code, 0);
    assert.equal(json.data[0].id, 887981);
    assert.equal((await cli('api', 'GET', 'https://evil.example/x')).code, 2);
  });

  it('reports PoliTO errors as JSON on stderr with exit code 1', async () => {
    fake.state.fail.set('/exams', 500);
    const { code, err } = await cli('exams');
    fake.state.fail.delete('/exams');
    assert.equal(code, 1);
    assert.match(err, /GET \/exams failed with HTTP 500: boom/);
  });

  it('never prints the password', async () => {
    fake.state.loginStatus = 401;
    const { code, err } = await cliEnv({ ...env, DATA_DIR: path.join(dir, 'fresh') }, 'grades');
    fake.state.loginStatus = 200;
    assert.equal(code, 1);
    assert.ok(!err.includes(PASSWORD));
  });
});
