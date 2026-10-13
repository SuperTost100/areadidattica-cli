// Manual check against the real PoliTO API. Run with `npm run live-check`.
//
//   --fresh-login   log in again even if a token is stored (to test whether
//                   that signs out the phone app)
//   --save <dir>    write the raw responses there, to refresh test fixtures.
//                   They contain personal data; the default dir is gitignored.
//
// Prints counts and titles only. Never prints the password or the token.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { parseNoticeScope, type Notification } from '../src/normalize.ts';
import { PolitoClient } from '../src/polito.ts';
import { Service } from '../src/service.ts';

const { values } = parseArgs({
  options: {
    'fresh-login': { type: 'boolean', default: false },
    save: { type: 'string' },
  },
});

const config = loadConfig();
const client = new PolitoClient({ ...config.polito, dataDir: config.dataDir, gapMs: 500 });
await client.init();

const hadToken = client.loggedIn;
if (values['fresh-login'] || !hadToken) {
  await client.login();
  console.log(`Logged in (${hadToken ? 'forced fresh login' : 'no stored token'}).`);
} else {
  console.log('Reusing the stored token.');
}

const raw: Record<string, unknown> = {};
const get = async <T>(p: string): Promise<T> => {
  const res = await client.get<T>(p);
  raw[p] = res;
  return res;
};

const notifications = (await get<{ data: Notification[] }>('/notifications')).data;
const messages = (await get<{ data: unknown[] }>('/messages')).data;
const deadlines = (await get<{ data: unknown[] }>('/deadlines')).data;
const noticeNotifs = notifications.filter((n) => parseNoticeScope(n.scope));

console.log(`/notifications: ${notifications.length} total, ${noticeNotifs.length} course avvisi`);
console.log(`/messages:      ${messages.length}`);
console.log(`/deadlines:     ${deadlines.length} (PoliTO default window)`);
console.log('Distinct notification scopes:');
for (const s of new Set(notifications.map((n) => JSON.stringify(n.scope?.map((x) => (/^\d+$/.test(x) ? '<id>' : x)))))) {
  console.log(`  ${s}`);
}

const items = await new Service(client, { noticesTtlMs: config.noticesTtlMs }).items();
console.log(`\nGET /items would return ${items.length} items. Newest 5:`);
for (const i of items.slice(0, 5)) {
  console.log(`  ${i.id}  ${i.isRead ? 'read  ' : 'UNREAD'}  ${i.course ?? '-'}  ${i.title}  (${i.text.length} chars)`);
}

if (values.save) {
  await mkdir(values.save, { recursive: true });
  for (const [p, body] of Object.entries(raw)) {
    const name = p.replace(/^\//, '').replace(/[/?=&]/g, '_') + '.json';
    await writeFile(path.join(values.save, name), JSON.stringify(body, null, 2), { mode: 0o600 });
  }
  console.log(`\nSaved raw responses to ${values.save}`);
}

console.log(`\nLogins this run: ${client.logins}. lastError: ${client.lastError ?? 'none'}`);
if (client.logins > 0) {
  console.log('Now open the PoliTO app on your phone and pull to refresh: is it still signed in?');
}
