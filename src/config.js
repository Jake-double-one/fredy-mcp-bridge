/*
 * Konfiguration aus Umgebungsvariablen. Alles, was geheim ist, kommt ausschließlich von hier –
 * niemals aus dem Repository.
 */

function env(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function required(name) {
  const value = env(name);
  if (value === undefined) {
    throw new Error(`Environment variable ${name} is missing.`);
  }
  return value;
}

function stripSlash(url) {
  return url.replace(/\/+$/, '');
}

export function loadConfig() {
  const publicUrl = stripSlash(required('PUBLIC_URL'));
  const parsed = new URL(publicUrl);
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('PUBLIC_URL must not contain a path, e.g. https://fredy-mcp.example.com');
  }

  return {
    port: Number(env('PORT', '3000')),
    publicUrl,
    mcpUrl: `${publicUrl}/mcp`,
    dataDir: env('DATA_DIR', '/data'),
    fredyUrl: stripSlash(env('FREDY_URL', 'http://fredy:9998')),
    // Muss zu Fredys Einstellungen unter „Anmeldung durch den Reverse-Proxy“ passen.
    proxyUserHeader: env('FREDY_PROXY_USER_HEADER', 'Remote-User'),
    proxySecretHeader: env('FREDY_PROXY_SECRET_HEADER', 'X-Fredy-Proxy-Secret'),
    proxySecret: required('FREDY_PROXY_SECRET'),
    // Optional: welcher Fredy-Admin genutzt wird, um die MCP-Tokens der Benutzer abzuholen.
    // Ohne Angabe nimmt die Bridge den Admin, der sich zuletzt an ihr angemeldet hat.
    adminUsername: env('FREDY_ADMIN_USERNAME'),
    // Welche vorgeschalteten Proxys X-Forwarded-For setzen dürfen (Express-Syntax).
    trustProxy: env('TRUST_PROXY', 'loopback, linklocal, uniquelocal'),
    accessTokenTtlSeconds: Number(env('ACCESS_TOKEN_TTL_SECONDS', String(60 * 60))),
    refreshTokenTtlSeconds: Number(env('REFRESH_TOKEN_TTL_SECONDS', String(60 * 60 * 24 * 30))),
    webSessionTtlSeconds: Number(env('WEB_SESSION_TTL_SECONDS', String(60 * 60 * 12))),
    logLevel: env('LOG_LEVEL', 'info'),
  };
}
