import { loadConfig } from './config.ts';
import { PolitoClient } from './polito.ts';
import { createServer } from './server.ts';
import { Service } from './service.ts';

const config = loadConfig();
const client = new PolitoClient({
  ...config.polito,
  dataDir: config.dataDir,
  gapMs: config.upstreamGapMs,
});
await client.init();

const service = new Service(client, { noticesTtlMs: config.noticesTtlMs });
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const server = createServer({ service, client, apiToken: config.apiToken, log });

server.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
