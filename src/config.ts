export interface Config {
  host: string;
  port: number;
  apiToken: string;
  dataDir: string;
  polito: {
    baseUrl: string;
    username: string;
    password: string;
    appVersion: string;
    buildNumber: string;
  };
  noticesTtlMs: number;
  upstreamGapMs: number;
}

// Reads settings from the environment. Error messages name missing variables,
// never their values.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ['POLITO_USERNAME', 'POLITO_PASSWORD', 'API_TOKEN'].filter(
    (k) => !env[k],
  );
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (env.API_TOKEN!.length < 24) {
    throw new Error('API_TOKEN must be at least 24 characters');
  }
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8788),
    apiToken: env.API_TOKEN!,
    dataDir: env.DATA_DIR || './data',
    polito: {
      baseUrl: env.POLITO_BASE_URL || 'https://app.didattica.polito.it/api',
      username: env.POLITO_USERNAME!,
      password: env.POLITO_PASSWORD!,
      appVersion: env.POLITO_APP_VERSION || '1.6.2',
      buildNumber: env.POLITO_BUILD_NUMBER || '1060200',
    },
    noticesTtlMs: Number(env.NOTICES_CACHE_SECONDS || 300) * 1000,
    upstreamGapMs: Number(env.UPSTREAM_GAP_MS || 250),
  };
}
