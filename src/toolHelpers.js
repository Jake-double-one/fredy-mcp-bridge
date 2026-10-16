/*
 * Gemeinsame Bausteine für die Bridge-Tools.
 */

export function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

export function failure(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function fredyFailure(status, data, fallback) {
  const detail = data?.message || data?.error || (typeof data === 'string' ? data : null);
  if (status === 401) {
    return failure('Fredy did not accept the bridge sign-in for this user (HTTP 401). Ask the admin to check the reverse-proxy sign-in settings in Fredy.');
  }
  return failure(`${fallback} Fredy answered HTTP ${status}${detail ? `: ${detail}` : '.'}`);
}

export function requireString(args, name) {
  const value = args?.[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`"${name}" is required.`);
  return value.trim();
}

/** Liest die Benutzereinstellungen aus Fredy (oder wirft eine verständliche Meldung). */
export async function readUserSettings(fredy, username) {
  const res = await fredy.asUser(username, 'GET', '/api/user/settings');
  if (res.status !== 200) return { error: fredyFailure(res.status, res.data, 'Could not read your Fredy settings.') };
  return { settings: res.data || {} };
}

/**
 * Bremse für Tools, die nach außen gehen (Portale, Routing-Dienste): ein Aufruf gleichzeitig und
 * höchstens `perHour` pro Benutzer und Stunde. `release()` nimmt einen Aufruf zurück, der Fredy
 * gar nicht erst erreicht hat.
 */
export function createLimiter(perHour) {
  const users = new Map();
  return {
    perHour,
    acquire(username) {
      const state = users.get(username) || { running: false, times: [] };
      users.set(username, state);
      state.times = state.times.filter((t) => t > Date.now() - 60 * 60 * 1000);
      if (state.running) return { error: 'Another request of this kind is still running. Wait for it to finish, then try again.' };
      if (state.times.length >= perHour) {
        const minutes = Math.ceil((state.times[0] + 60 * 60 * 1000 - Date.now()) / 60000);
        return { error: `Limit of ${perHour} requests of this kind per hour reached. Try again in about ${minutes} minute(s).` };
      }
      state.running = true;
      state.times.push(Date.now());
      return {
        done: () => {
          state.running = false;
        },
        release: () => {
          state.times.pop();
        },
      };
    },
  };
}
