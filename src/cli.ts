// The `areadidattica` command: reads your PoliTO account and prints JSON.
// Each run logs in only when the stored token is missing or refused.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { loadPolitoConfig } from './config.ts';
import { downloadFiles, flattenFiles, type UpstreamEntry } from './files.ts';
import { htmlToText, romeDate, romeDay, type CourseNotice } from './normalize.ts';
import { PolitoClient } from './polito.ts';
import { BadRequest, Service } from './service.ts';

export interface Io {
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_MB = 200;

const OPTIONS = {
  'allow-writes': { type: 'boolean' },
  unread: { type: 'boolean' },
  fresh: { type: 'boolean' },
  force: { type: 'boolean' },
  live: { type: 'boolean' },
  from: { type: 'string' },
  to: { type: 'string' },
  date: { type: 'string' },
  since: { type: 'string' },
  search: { type: 'string' },
  course: { type: 'string' },
  site: { type: 'string' },
  out: { type: 'string' },
  'max-mb': { type: 'string' },
  body: { type: 'string' },
  seat: { type: 'string' },
  reason: { type: 'string' },
  'question-id': { type: 'string' },
  'question-option': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Opts = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'boolean' ? boolean : string };

class Usage extends Error {}

interface Ctx {
  io: Io;
  opts: Opts;
  args: string[];
  client: PolitoClient;
  service: Service;
  dataDir: string;
}

interface Command {
  usage: string;
  help: string;
  // Changes something on PoliTO, so it needs --allow-writes.
  write?: boolean;
  // Runs without PoliTO credentials.
  offline?: boolean;
  run: (ctx: Ctx) => Promise<unknown>;
}

const data = async <T = unknown>(ctx: Ctx, apiPath: string): Promise<T> =>
  (await ctx.client.get<{ data: T }>(apiPath)).data;

const arg = (ctx: Ctx, i: number, name: string): string => {
  const v = ctx.args[i];
  if (!v) throw new Usage(`missing <${name}>`);
  return v;
};

const id = (ctx: Ctx, i: number, name: string): string => {
  const v = arg(ctx, i, name);
  if (!/^\d+$/.test(v)) throw new Usage(`<${name}> must be a number, got "${v}"`);
  return v;
};

const date = (v: string | undefined, name: string): string | undefined => {
  if (v !== undefined && !DATE.test(v)) throw new Usage(`--${name} must be YYYY-MM-DD`);
  return v;
};

const course = (ctx: Ctx, i = 0) => ctx.service.resolveCourse(arg(ctx, i, 'course'));

const query = (params: Record<string, string | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
};

const COMMANDS: Record<string, Command> = {
  help: {
    usage: 'help',
    help: 'Show this help.',
    offline: true,
    run: async (ctx) => ctx.io.out(helpText()),
  },
  status: {
    usage: 'status',
    help: 'Whether a token is stored, and where files go. Makes no PoliTO call.',
    run: async (ctx) => ({
      loggedIn: ctx.client.loggedIn,
      dataDir: ctx.dataDir,
      downloadDir: downloadDir(ctx),
      writesAllowed: !!ctx.opts['allow-writes'],
    }),
  },
  login: {
    usage: 'login [--fresh]',
    help: 'Log in now. Reuses a stored token unless --fresh.',
    run: async (ctx) => {
      if (ctx.opts.fresh || !ctx.client.loggedIn) await ctx.client.login();
      return { loggedIn: ctx.client.loggedIn, newLogin: ctx.client.logins > 0 };
    },
  },

  // Avvisi, messages and deadlines
  items: {
    usage: 'items [--unread]',
    help: 'Course avvisi and school messages, newest first, with the full text.',
    run: async (ctx) => ctx.service.items({ unreadOnly: !!ctx.opts.unread }),
  },
  read: {
    usage: 'read <item-id>',
    help: 'Mark an avviso or message read, like notification:901 or message:7001.',
    run: async (ctx) => {
      const itemId = arg(ctx, 0, 'item-id');
      await ctx.service.markRead(itemId);
      return { ok: true, id: itemId };
    },
  },
  deadlines: {
    usage: 'deadlines [--from YYYY-MM-DD] [--to YYYY-MM-DD]',
    help: 'Administrative deadlines. Default: today to 30 days from today.',
    run: async (ctx) =>
      ctx.service.deadlines(date(ctx.opts.from, 'from') ?? romeDate(0), date(ctx.opts.to, 'to') ?? romeDate(30)),
  },

  // Courses
  courses: {
    usage: 'courses',
    help: 'Your courses with their ids and shortcodes.',
    run: async (ctx) => ctx.service.courses(),
  },
  course: {
    usage: 'course <course>',
    help: 'One course: teachers, credits, period.',
    run: async (ctx) => data(ctx, `/courses/${(await course(ctx)).id}`),
  },
  guide: {
    usage: 'guide <course>',
    help: 'The course guide: program, exam rules, books.',
    run: async (ctx) => data(ctx, `/courses/${(await course(ctx)).id}/guide`),
  },
  notices: {
    usage: 'notices <course>',
    help: 'Every avviso the course still shows, as plain text, newest first.',
    run: async (ctx) => {
      const notices = await data<CourseNotice[]>(ctx, `/courses/${(await course(ctx)).id}/notices`);
      return notices
        .map((n) => ({ id: n.id, publishedAt: n.publishedAt, expiresAt: n.expiresAt, text: htmlToText(n.content) }))
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    },
  },
  files: {
    usage: 'files [<course>] [--since YYYY-MM-DD] [--search TEXT]',
    help: 'Course material as a flat list. Without a course, every course.',
    run: async (ctx) => {
      const since = date(ctx.opts.since, 'since');
      const search = ctx.opts.search?.toLowerCase();
      const one = ctx.args[0] ? await course(ctx) : null;
      const targets = one ? [one] : await ctx.service.courseList();
      const out = [];
      for (const c of targets) {
        let tree: UpstreamEntry[];
        try {
          tree = await data<UpstreamEntry[]>(ctx, `/courses/${c.id}/files`);
        } catch (err) {
          // Across all courses, one course without material mustn't hide the rest.
          if (one) throw err;
          ctx.io.err(JSON.stringify({ warning: `skipped ${c.name} (${c.id}): ${(err as Error).message}` }) + '\n');
          continue;
        }
        const files = flattenFiles(tree)
          .filter((f) => !since || romeDay(f.createdAt) >= since)
          .filter((f) => !search || `${f.folder}/${f.name}`.toLowerCase().includes(search));
        out.push(...files.map((f) => ({ courseId: c.id, course: c.name, ...f })));
      }
      return out;
    },
  },
  download: {
    usage: 'download <course> <file-or-folder-id>... [--out DIR] [--max-mb N] [--force]',
    help: `Save files, or every file in a folder, under DIR/<course> (<id>)/. Skips files unchanged since the last download. Stops at --max-mb in total (default ${DEFAULT_MAX_MB}).`,
    run: async (ctx) => {
      const c = await course(ctx);
      const ids = ctx.args.slice(1);
      if (!ids.length) throw new Usage('missing <file-or-folder-id>');
      const maxMb = Number(ctx.opts['max-mb'] ?? DEFAULT_MAX_MB);
      if (!(maxMb > 0)) throw new Usage('--max-mb must be a positive number');
      const tree = await data<UpstreamEntry[]>(ctx, `/courses/${c.id}/files`);
      const allFiles = flattenFiles(tree);
      const files = [];
      for (const fileId of ids) {
        const found = flattenFiles(tree, fileId);
        if (!found.length) throw new BadRequest(`no file or non-empty folder ${fileId} in ${c.name}`);
        files.push(...found);
      }
      return downloadFiles(ctx.client, {
        courseId: c.id,
        courseName: c.name,
        files: [...new Map(files.map((f) => [f.id, f])).values()],
        allFiles,
        outDir: downloadDir(ctx),
        maxBytes: maxMb * 1e6,
        manifestFile: path.join(ctx.dataDir, 'downloads.json'),
        force: !!ctx.opts.force,
      });
    },
  },
  lectures: {
    usage: 'lectures [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--course C]',
    help: 'Timetable. PoliTO defaults to 7 days before and after today.',
    run: async (ctx) => {
      const params: Record<string, string | undefined> = {
        fromDate: date(ctx.opts.from, 'from'),
        toDate: date(ctx.opts.to, 'to'),
      };
      if (ctx.opts.course) params['courseIds[]'] = (await ctx.service.resolveCourse(ctx.opts.course)).id;
      return data(ctx, `/lectures${query(params)}`);
    },
  },
  'next-lecture': {
    usage: 'next-lecture <course>',
    help: 'The next lecture of a course.',
    run: async (ctx) => data(ctx, `/courses/${(await course(ctx)).id}/nextLecture`),
  },
  videolectures: {
    usage: 'videolectures <course>',
    help: 'Recorded lectures with video and audio links.',
    run: async (ctx) => data(ctx, `/courses/${(await course(ctx)).id}/videolectures`),
  },
  'virtual-classrooms': {
    usage: 'virtual-classrooms <course> [--live]',
    help: 'Virtual classroom recordings, or the live ones with --live.',
    run: async (ctx) =>
      data(ctx, `/courses/${(await course(ctx)).id}/virtual-classrooms${ctx.opts.live ? '?live=true' : ''}`),
  },
  assignments: {
    usage: 'assignments <course>',
    help: 'Assignments (elaborati) you uploaded.',
    run: async (ctx) => data(ctx, `/courses/${(await course(ctx)).id}/assignments`),
  },

  // Exams and career
  exams: { usage: 'exams', help: 'Exam sessions (appelli) and whether you can book them.', run: (ctx) => data(ctx, '/exams') },
  grades: { usage: 'grades', help: 'Grades on your record.', run: (ctx) => data(ctx, '/grades') },
  'provisional-grades': {
    usage: 'provisional-grades',
    help: 'Grades waiting for you to accept or reject.',
    run: (ctx) => data(ctx, '/provisional-grades'),
  },
  career: { usage: 'career', help: 'Degree, enrolment and credits.', run: (ctx) => data(ctx, '/student/career') },
  profile: { usage: 'profile', help: 'Your PoliTO profile.', run: (ctx) => data(ctx, '/auth/profile') },

  // Bookings
  bookings: { usage: 'bookings', help: 'Your bookings (seats, offices, events).', run: (ctx) => data(ctx, '/bookings') },
  'booking-topics': { usage: 'booking-topics', help: 'What you can book.', run: (ctx) => data(ctx, '/booking-topics') },
  'booking-slots': {
    usage: 'booking-slots <topic-id> [--from YYYY-MM-DD] [--to YYYY-MM-DD]',
    help: 'Free slots for one booking topic.',
    run: async (ctx) =>
      data(
        ctx,
        `/booking-topics/${encodeURIComponent(arg(ctx, 0, 'topic-id'))}/slots${query({ fromDate: date(ctx.opts.from, 'from'), toDate: date(ctx.opts.to, 'to') })}`,
      ),
  },
  'booking-seats': {
    usage: 'booking-seats <topic-id> <slot-id>',
    help: 'Seats in one booking slot.',
    run: async (ctx) =>
      data(ctx, `/booking-topics/${encodeURIComponent(arg(ctx, 0, 'topic-id'))}/slots/${id(ctx, 1, 'slot-id')}/seats`),
  },

  // Campus
  news: {
    usage: 'news [<id>]',
    help: 'PoliTO news, or one news item.',
    run: async (ctx) => data(ctx, ctx.args[0] ? `/news/${id(ctx, 0, 'id')}` : '/news'),
  },
  'job-offers': {
    usage: 'job-offers [<id>]',
    help: 'Job offers for students, or one offer.',
    run: async (ctx) => data(ctx, ctx.args[0] ? `/job-offers/${id(ctx, 0, 'id')}` : '/job-offers'),
  },
  people: {
    usage: 'people <search>',
    help: 'Search teachers and staff by name.',
    run: async (ctx) => data(ctx, `/people${query({ search: ctx.args.join(' ') || arg(ctx, 0, 'search') })}`),
  },
  person: {
    usage: 'person <id>',
    help: 'One person: office, phone, courses.',
    run: async (ctx) => data(ctx, `/people/${id(ctx, 0, 'id')}`),
  },
  sites: { usage: 'sites', help: 'Campus sites, with the ids other commands take.', run: (ctx) => data(ctx, '/v2/sites') },
  buildings: {
    usage: 'buildings <site-id>',
    help: 'Buildings of a site.',
    run: async (ctx) => data(ctx, `/v2/sites/${encodeURIComponent(arg(ctx, 0, 'site-id'))}/buildings`),
  },
  places: {
    usage: 'places [--search TEXT] [--site SITE-ID]',
    help: 'Rooms, labs and offices.',
    run: async (ctx) => data(ctx, `/v2/places${query({ search: ctx.opts.search, siteId: ctx.opts.site })}`),
  },
  place: {
    usage: 'place <place-id>',
    help: 'One room, lab or office.',
    run: async (ctx) => data(ctx, `/v2/places/${encodeURIComponent(arg(ctx, 0, 'place-id'))}`),
  },
  'free-rooms': {
    usage: 'free-rooms <site-id> --date YYYY-MM-DD --from HH:MM --to HH:MM',
    help: 'Rooms free in a time range.',
    run: async (ctx) => {
      const site = arg(ctx, 0, 'site-id');
      const day = date(ctx.opts.date, 'date');
      if (!day || !ctx.opts.from || !ctx.opts.to) throw new Usage('free-rooms needs --date, --from and --to');
      return data(ctx, `/v2/sites/${encodeURIComponent(site)}/free-rooms${query({ date: day, timeFrom: ctx.opts.from, timeTo: ctx.opts.to })}`);
    },
  },

  // Everything else
  tickets: {
    usage: 'tickets [<id>]',
    help: 'Your support tickets, or one ticket with its replies.',
    run: async (ctx) => data(ctx, ctx.args[0] ? `/student/tickets/${id(ctx, 0, 'id')}` : '/student/tickets'),
  },
  surveys: { usage: 'surveys', help: 'Surveys (CPD) waiting for you.', run: (ctx) => data(ctx, '/surveys') },
  'unread-emails': { usage: 'unread-emails', help: 'How many unread mails your PoliTO inbox has.', run: (ctx) => data(ctx, '/unreadEmails') },
  announcements: { usage: 'announcements', help: 'Announcements from the PoliTO app.', run: (ctx) => data(ctx, '/announcements') },
  events: { usage: 'events', help: 'Upcoming events you are admitted to.', run: (ctx) => data(ctx, '/event-admissions') },
  offering: { usage: 'offering', help: 'The degree programmes on offer.', run: (ctx) => data(ctx, '/offering') },
  guides: { usage: 'guides', help: 'Student guides from the PoliTO app.', run: (ctx) => data(ctx, '/guides') },
  api: {
    usage: 'api <method> <path> [--body JSON]',
    help: 'Call any PoliTO API path, like `api GET /notifications`. Anything but GET needs --allow-writes.',
    run: async (ctx) => {
      const method = arg(ctx, 0, 'method').toUpperCase();
      const apiPath = arg(ctx, 1, 'path');
      if (!/^\/[^\s]*$/.test(apiPath) || apiPath.startsWith('//')) throw new Usage('<path> must start with / and be a PoliTO API path');
      if (method !== 'GET' && !ctx.opts['allow-writes']) throw new Usage(writeRefusal(`api ${method}`));
      let body: unknown;
      if (ctx.opts.body !== undefined) {
        try {
          body = JSON.parse(ctx.opts.body);
        } catch {
          throw new Usage('--body must be JSON');
        }
      }
      return ctx.client.request(method, apiPath, body);
    },
  },

  // Writes
  'exam-book': {
    usage: 'exam-book <exam-id> [--reason TEXT] [--question-id N --question-option N]',
    help: 'Book an exam session. Some sessions ask a question or a reason first; `exams` shows it.',
    write: true,
    run: async (ctx) => {
      const examId = id(ctx, 0, 'exam-id');
      const exam = (await data<{ id: number; courseShortcode: string }[]>(ctx, '/exams')).find((e) => String(e.id) === examId);
      if (!exam) throw new BadRequest(`no exam ${examId} in your exam list`);
      const num = (name: 'question-id' | 'question-option') => {
        const v = ctx.opts[name];
        if (v === undefined) return undefined;
        if (!/^\d+$/.test(v)) throw new Usage(`--${name} must be a number`);
        return Number(v);
      };
      return ctx.client.request('POST', `/exams/${examId}/booking`, {
        courseShortcode: exam.courseShortcode,
        questionId: num('question-id'),
        questionOption: num('question-option'),
        requestReason: ctx.opts.reason,
      });
    },
  },
  'exam-cancel': {
    usage: 'exam-cancel <exam-id>',
    help: 'Cancel an exam booking.',
    write: true,
    run: async (ctx) => ctx.client.request('DELETE', `/exams/${id(ctx, 0, 'exam-id')}/booking`),
  },
  'grade-accept': {
    usage: 'grade-accept <provisional-grade-id>',
    help: 'Accept a provisional grade. It goes on your record and cannot be undone.',
    write: true,
    run: async (ctx) => ctx.client.request('POST', `/provisional-grades/${id(ctx, 0, 'provisional-grade-id')}/accept`),
  },
  'grade-reject': {
    usage: 'grade-reject <provisional-grade-id>',
    help: 'Reject a provisional grade. You will have to take the exam again.',
    write: true,
    run: async (ctx) => ctx.client.request('POST', `/provisional-grades/${id(ctx, 0, 'provisional-grade-id')}/reject`),
  },
  'booking-create': {
    usage: 'booking-create <slot-id> [--seat N]',
    help: 'Book a slot from `booking-slots`, with a seat from `booking-seats` when it asks for one.',
    write: true,
    run: async (ctx) => {
      const seat = ctx.opts.seat;
      if (seat !== undefined && !/^\d+$/.test(seat)) throw new Usage('--seat must be a number');
      return ctx.client.request('POST', '/bookings', {
        slotId: Number(id(ctx, 0, 'slot-id')),
        seatId: seat === undefined ? undefined : Number(seat),
      });
    },
  },
  'booking-cancel': {
    usage: 'booking-cancel <booking-id>',
    help: 'Cancel a booking.',
    write: true,
    run: async (ctx) => ctx.client.request('DELETE', `/bookings/${id(ctx, 0, 'booking-id')}`),
  },
};

function downloadDir(ctx: Ctx): string {
  return path.resolve(ctx.opts.out ?? ctx.io.env.AREADIDATTICA_DOWNLOADS ?? path.join(home(ctx.io.env), 'Downloads', 'polito'));
}

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME || os.homedir();
}

function writeRefusal(name: string): string {
  return `${name} changes your PoliTO account, so it runs only with --allow-writes`;
}

function helpText(): string {
  const line = (c: Command) => `  ${c.usage}\n      ${c.help}`;
  const reads = Object.values(COMMANDS).filter((c) => !c.write);
  const writes = Object.values(COMMANDS).filter((c) => c.write);
  return [
    'areadidattica: your PoliTO account from the command line. Every command prints JSON.',
    '',
    'Usage: areadidattica <command> [arguments] [options]',
    '',
    '<course> is a course id, a shortcode like 01NYHOV, or part of the course name.',
    '',
    'Commands:',
    ...reads.map(line),
    '',
    'Commands that change your PoliTO account (they need --allow-writes):',
    ...writes.map(line),
    '',
    'Settings come from the environment, or from ~/.config/areadidattica/env:',
    '  POLITO_USERNAME, POLITO_PASSWORD  your PoliTO login (required)',
    '  DATA_DIR                          session and download records (default ~/.local/state/areadidattica)',
    '  AREADIDATTICA_DOWNLOADS           where downloads go (default ~/Downloads/polito)',
    '',
  ].join('\n');
}

// Values from the env file fill in what the environment doesn't set.
function withEnvFile(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const configHome = env.XDG_CONFIG_HOME || path.join(home(env), '.config');
  const file = env.AREADIDATTICA_ENV_FILE || path.join(configHome, 'areadidattica', 'env');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !env.AREADIDATTICA_ENV_FILE) return env;
    throw new Error(`could not read ${file}: ${(err as NodeJS.ErrnoException).code ?? err}`);
  }
  return { ...parseEnv(text), ...env };
}

export async function run(argv: string[], io: Io): Promise<number> {
  const print = (value: unknown) => io.out(JSON.stringify(value, null, 2) + '\n');
  const fail = (code: number, message: string) => {
    io.err(JSON.stringify({ error: message }) + '\n');
    return code;
  };

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    return fail(2, `${(err as Error).message}. Run "areadidattica help".`);
  }
  const [name = 'help', ...args] = parsed.positionals;
  const opts = parsed.values as Opts;
  const command = opts.help ? COMMANDS.help! : COMMANDS[name];
  if (!command) return fail(2, `unknown command "${name}". Run "areadidattica help".`);
  if (command.write && !opts['allow-writes']) return fail(2, writeRefusal(name));

  try {
    const env = withEnvFile(io.env);
    const dataDir = path.resolve(
      env.DATA_DIR || path.join(env.XDG_STATE_HOME || path.join(home(env), '.local', 'state'), 'areadidattica'),
    );
    const ctx: Ctx = { io: { ...io, env }, opts, args, dataDir } as Ctx;
    if (!command.offline) {
      let polito;
      try {
        polito = loadPolitoConfig(env);
      } catch (err) {
        throw new Error(`${(err as Error).message}. Set them, or put them in ~/.config/areadidattica/env`);
      }
      ctx.client = new PolitoClient({
        ...polito,
        dataDir,
        gapMs: Number(env.UPSTREAM_GAP_MS || 250),
      });
      await ctx.client.init();
      ctx.service = new Service(ctx.client, { noticesTtlMs: 0 });
    }
    const result = await command.run(ctx);
    if (result !== undefined) print(result ?? null);
    return 0;
  } catch (err) {
    if (err instanceof Usage) return fail(2, `${err.message}. Usage: areadidattica ${command.usage}`);
    if (err instanceof BadRequest) return fail(2, err.message);
    // PoliTO failures (UpstreamError) and anything unexpected.
    return fail(1, (err as Error).message);
  }
}

if (import.meta.main) {
  // A closed pipe, like `areadidattica help | head`, isn't an error.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}
