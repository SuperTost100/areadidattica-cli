import { createHash } from 'node:crypto';

// Upstream shapes, from the PoliTO student OpenAPI spec.
export interface Notification {
  id: number;
  title: string;
  message: string | null;
  // Ids inside the scope arrive as numbers from the live API, as strings in the spec.
  scope?: (string | number)[];
  sentAt: string;
  isRead: boolean;
}

export interface Message {
  id: number;
  title: string;
  message: string | null;
  type: string;
  senderId: number | null;
  sentAt: string;
  isRead: boolean;
}

export interface CourseNotice {
  id: number;
  publishedAt: string;
  expiresAt: string | null;
  content: string;
}

export interface Deadline {
  id?: number;
  name: string;
  type: string;
  url: string | null;
  date: string;
}

// Our output shapes.
export interface Item {
  id: string;
  kind: 'avviso' | 'message';
  course: string | null;
  title: string;
  text: string;
  sentAt: string;
  isRead: boolean;
  urgent: boolean;
  sourceUrl: string | null;
}

export interface DeadlineItem {
  id: string;
  title: string;
  date: string;
  course: string | null;
  type: string;
  url: string | null;
}

export interface NoticeScope {
  courseKey: string;
  noticeId: number | null;
}

// Notification scopes look like ["courses","258674","notices"], optionally
// prefixed with "teaching" and followed by the notice id. Returns null for
// anything that isn't a course notice (files, lectures, tickets, messages).
export function parseNoticeScope(scope: (string | number)[] | undefined): NoticeScope | null {
  if (!scope) return null;
  const i = scope.indexOf('courses');
  if (i < 0 || scope[i + 2] !== 'notices' || !scope[i + 1]) return null;
  const noticeId = Number(scope[i + 3]);
  return {
    courseKey: String(scope[i + 1]),
    noticeId: Number.isInteger(noticeId) && noticeId > 0 ? noticeId : null,
  };
}

// Notifications scoped to a school message: ["messages","123"].
export function messageIdFromScope(scope: (string | number)[] | undefined): number | null {
  if (!scope) return null;
  const i = scope.indexOf('messages');
  const id = Number(scope[i + 1]);
  return i >= 0 && Number.isInteger(id) ? id : null;
}

const MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

// Finds the notice a notification refers to: by id when the scope carries
// one, otherwise the notice published closest to the notification (within a day).
export function pickNotice(
  notices: CourseNotice[],
  scope: NoticeScope,
  sentAt: string,
): CourseNotice | undefined {
  if (scope.noticeId !== null) return notices.find((n) => n.id === scope.noticeId);
  const sent = Date.parse(sentAt);
  let best: CourseNotice | undefined;
  let bestDiff = MATCH_WINDOW_MS;
  for (const n of notices) {
    const diff = Math.abs(Date.parse(n.publishedAt) - sent);
    if (diff <= bestDiff) {
      best = n;
      bestDiff = diff;
    }
  }
  return best;
}

const TITLE_COURSE = /^nuovo avviso (?:da|dal corso(?: di)?|nel corso(?: di)?)\s+(.+)$/i;

export function courseFromTitle(title: string): string | null {
  return TITLE_COURSE.exec(title.trim())?.[1]?.trim() ?? null;
}

export function avvisoItem(
  n: Notification,
  course: string | null,
  notice: CourseNotice | undefined,
): Item {
  return {
    id: `notification:${n.id}`,
    kind: 'avviso',
    course,
    title: n.title,
    text: notice ? htmlToText(notice.content) : toText(n.message),
    sentAt: n.sentAt,
    isRead: n.isRead,
    urgent: false,
    sourceUrl: null,
  };
}

export function messageItem(m: Message): Item {
  return {
    id: `message:${m.id}`,
    kind: 'message',
    course: null,
    title: m.title,
    text: toText(m.message),
    sentAt: m.sentAt,
    isRead: m.isRead,
    urgent: m.type === 'emergency',
    sourceUrl: null,
  };
}

export function deadlineItem(d: Deadline): DeadlineItem {
  // Most deadlines come without an id, so derive one from date and name.
  const id = d.id ?? createHash('sha1').update(`${d.date}|${d.name}`).digest('hex').slice(0, 12);
  return {
    id: `deadline:${id}`,
    title: d.name,
    date: d.date,
    course: null,
    type: d.type,
    url: d.url,
  };
}

function toText(s: string | null): string {
  if (!s) return '';
  return /<\/?[a-z][^>]*>/i.test(s) ? htmlToText(s) : s;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  agrave: 'à', aacute: 'á', egrave: 'è', eacute: 'é', igrave: 'ì', iacute: 'í',
  ograve: 'ò', oacute: 'ó', ugrave: 'ù', uacute: 'ú',
  Agrave: 'À', Egrave: 'È', Eacute: 'É', Igrave: 'Ì', Ograve: 'Ò', Ugrave: 'Ù',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  ndash: '–', mdash: '—', hellip: '…', euro: '€', deg: '°', middot: '·',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

// Turns notice HTML into plain text. Keeps the wording untouched; only
// markup goes. Links become "label (url)" so the URL isn't lost.
export function htmlToText(html: string): string {
  const text = html
    // Raw line breaks in HTML are just spaces; only tags break lines.
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const l = label.replace(/<[^>]+>/g, '').trim();
      const url = decodeEntities(href);
      return !l || decodeEntities(l) === url ? url : `${l} (${url})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|table|tr|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
