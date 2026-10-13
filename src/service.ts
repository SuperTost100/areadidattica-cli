import type { PolitoClient } from './polito.ts';
import {
  avvisoItem,
  courseFromTitle,
  deadlineItem,
  messageIdFromScope,
  messageItem,
  parseNoticeScope,
  pickNotice,
  type CourseNotice,
  type Deadline,
  type DeadlineItem,
  type Item,
  type Message,
  type Notification,
} from './normalize.ts';

interface CourseOverview {
  id: number | null;
  name: string;
  shortcode?: string;
  modules?: { id: number | null; name: string }[] | null;
}

interface Cached<T> {
  at: number;
  data: T;
}

const COURSES_TTL_MS = 6 * 60 * 60 * 1000;

export class BadRequest extends Error {}

export class Service {
  #client: PolitoClient;
  #noticesTtlMs: number;
  #now: () => number;
  #notices = new Map<string, Cached<CourseNotice[]>>();
  #courses: Cached<Map<string, string>> | null = null;
  // Last notification feed, used to clear notifications tied to a message.
  #lastNotifications: Notification[] | null = null;

  constructor(client: PolitoClient, opts: { noticesTtlMs: number; now?: () => number }) {
    this.#client = client;
    this.#noticesTtlMs = opts.noticesTtlMs;
    this.#now = opts.now ?? Date.now;
  }

  async items({ unreadOnly = false } = {}): Promise<Item[]> {
    const notifications = (await this.#client.get<{ data: Notification[] }>('/notifications')).data;
    const messages = (await this.#client.get<{ data: Message[] }>('/messages')).data;
    this.#lastNotifications = notifications;

    const avvisi = notifications
      .map((n) => ({ n, scope: parseNoticeScope(n.scope) }))
      .filter((x) => x.scope && (!unreadOnly || !x.n.isRead));

    const courseNames = avvisi.length ? await this.#courseNames() : new Map<string, string>();
    const items: Item[] = [];
    for (const { n, scope } of avvisi) {
      const notices = await this.#courseNotices(scope!.courseKey);
      const course = courseNames.get(scope!.courseKey) ?? courseFromTitle(n.title);
      items.push(avvisoItem(n, course, pickNotice(notices, scope!, n.sentAt)));
    }
    for (const m of messages) {
      if (!unreadOnly || !m.isRead) items.push(messageItem(m));
    }
    return items.sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
  }

  async markRead(id: string): Promise<void> {
    const match = /^(notification|message):(\d+)$/.exec(id);
    if (!match) throw new BadRequest(`unknown item id "${id}"`);
    const [, kind, num] = match;
    if (kind === 'notification') {
      await this.#client.put(`/notifications/${num}/read`);
      return;
    }
    await this.#client.put(`/messages/${num}/read`);
    // The phone also shows a notification for the message; clear it too.
    // The message is already marked read, so a failure here doesn't fail
    // the request; it shows up in /health as lastError.
    try {
      this.#lastNotifications ??= (
        await this.#client.get<{ data: Notification[] }>('/notifications')
      ).data;
      for (const n of this.#lastNotifications) {
        if (!n.isRead && messageIdFromScope(n.scope) === Number(num)) {
          await this.#client.put(`/notifications/${n.id}/read`);
          n.isRead = true;
        }
      }
    } catch {
      return;
    }
  }

  async deadlines(from: string, to: string): Promise<DeadlineItem[]> {
    const q = new URLSearchParams({ fromDate: from, toDate: to });
    const res = await this.#client.get<{ data: Deadline[] }>(`/deadlines?${q}`);
    return res.data.map(deadlineItem).sort((a, b) => a.date.localeCompare(b.date));
  }

  // Notice lists are cached per course. The endpoint takes numeric ids only;
  // for anything else, and when the fetch fails, the avviso falls back to the
  // notification text.
  async #courseNotices(courseKey: string): Promise<CourseNotice[]> {
    if (!/^\d+$/.test(courseKey)) return [];
    const hit = this.#notices.get(courseKey);
    if (hit && this.#now() - hit.at < this.#noticesTtlMs) return hit.data;
    try {
      const res = await this.#client.get<{ data: CourseNotice[] }>(`/courses/${courseKey}/notices`);
      this.#notices.set(courseKey, { at: this.#now(), data: res.data });
      return res.data;
    } catch {
      return hit?.data ?? [];
    }
  }

  // Maps course ids and shortcodes to course names. Falls back to parsing the
  // notification title when the course list can't be loaded.
  async #courseNames(): Promise<Map<string, string>> {
    if (this.#courses && this.#now() - this.#courses.at < COURSES_TTL_MS) return this.#courses.data;
    const names = new Map<string, string>();
    try {
      const res = await this.#client.get<{ data: CourseOverview[] }>('/v2/courses');
      for (const c of res.data) {
        if (c.id != null) names.set(String(c.id), c.name);
        if (c.shortcode) names.set(c.shortcode, c.name);
        for (const m of c.modules ?? []) {
          if (m.id != null) names.set(String(m.id), m.name);
        }
      }
      this.#courses = { at: this.#now(), data: names };
    } catch {
      return this.#courses?.data ?? names;
    }
    return names;
  }
}
