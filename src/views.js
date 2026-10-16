/*
 * Server-seitig gerenderte Seiten. Kein Build-Schritt, kein externes Asset.
 */

import { PERMISSIONS, ROLES } from './permissions.js';

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(seconds) {
  if (!seconds) return 'noch nie';
  return new Date(seconds * 1000).toLocaleString('de-DE', {
    timeZone: process.env.TZ || 'Europe/Berlin',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

const CSS = `
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--fg:#1f2430;--muted:#6b7280;--line:#e5e7eb;--accent:#e2564d;--accent-fg:#fff;--chip:#f3f4f6;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--danger-bg:#fef2f2}
@media(prefers-color-scheme:dark){:root{--bg:#15171c;--card:#1e2128;--fg:#e8eaed;--muted:#9aa1ac;--line:#2c313b;--chip:#262b34;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--danger-bg:#2a1a1c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent)}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--card)}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:17px;color:var(--fg);text-decoration:none}
.brand .heart{color:var(--accent)}
.who{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--muted)}
main{max-width:880px;margin:0 auto;padding:24px 16px 64px}
main.narrow{max-width:440px;padding-top:8vh}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;margin-bottom:18px}
h1{font-size:22px;margin:0 0 6px;letter-spacing:-.02em}
h2{font-size:17px;margin:0 0 12px}
.lead{margin:0 0 18px;color:var(--muted)}
label.field{display:block;margin-bottom:14px;font-size:14px;font-weight:600}
input[type=text],input[type=password]{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font:inherit}
.btn{display:inline-block;border:0;border-radius:10px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;text-align:center}
.btn-primary{background:var(--accent);color:var(--accent-fg)}
.btn-secondary{background:var(--chip);color:var(--fg)}
.btn-danger{background:transparent;color:var(--bad);border:1px solid var(--line)}
.btn-block{display:block;width:100%}
.btn-sm{padding:6px 12px;font-size:13px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.spread{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.muted{color:var(--muted)}
.small{font-size:13px}
.chip{display:inline-block;padding:2px 9px;border-radius:999px;background:var(--chip);font-size:12px;margin:2px 4px 2px 0}
.chip.off{text-decoration:line-through;opacity:.6}
.chip.admin{background:var(--accent);color:var(--accent-fg)}
.alert{padding:12px 14px;border-radius:10px;margin-bottom:16px;font-size:14px;border:1px solid var(--line)}
.alert.bad{color:var(--bad);background:var(--danger-bg)}
.alert.warn{color:var(--warn)}
.alert.ok{color:var(--ok)}
.perms{list-style:none;margin:0 0 18px;padding:0;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.perms li{padding:12px 14px}
.perms li+li{border-top:1px solid var(--line)}
.perms label{display:flex;gap:12px;align-items:flex-start;cursor:pointer}
.perms input{margin-top:4px;width:17px;height:17px;accent-color:var(--accent);flex:none}
.perms .title{font-weight:600}
.perms .desc{color:var(--muted);font-size:13px}
.perms li.locked{opacity:.55}
.perms li.danger .title{color:var(--bad)}
.section-label{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:18px 0 8px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.copy{display:flex;gap:8px}
.copy input{flex:1;margin:0}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
td.c,th.c{text-align:center}
td input{width:17px;height:17px;accent-color:var(--accent)}
.status li{margin-bottom:6px}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.conn+.conn{border-top:1px solid var(--line);padding-top:16px;margin-top:16px}
footer{text-align:center;color:var(--muted);font-size:12px;padding:20px}
`;

export function layout({ title, body, user, csrf, narrow = false }) {
  const who = user
    ? `<div class="who"><span>${esc(user.username)}</span>${user.isAdmin ? '<span class="chip admin">Admin</span>' : ''}
       <form method="post" action="/logout" style="margin:0"><input type="hidden" name="_csrf" value="${esc(csrf)}">
       <button class="btn btn-secondary btn-sm" type="submit">Abmelden</button></form></div>`
    : '';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Fredy MCP Bridge</title><style>${CSS}</style></head>
<body><header><a class="brand" href="/"><span class="heart">&#10084;</span> Fredy MCP Bridge</a>${who}</header>
<main class="${narrow ? 'narrow' : ''}">${body}</main>
<footer>Anmeldung mit deinem Fredy-Konto · Rechte und Sichtbarkeit bestimmt Fredy</footer></body></html>`;
}

export function loginPage({ error, next, username }) {
  return layout({
    title: 'Anmelden',
    narrow: true,
    body: `<div class="card"><h1>Anmelden</h1><p class="lead">Mit deinem Fredy-Benutzer und -Passwort.</p>
${error ? `<div class="alert bad">${esc(error)}</div>` : ''}
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next || '/')}">
<label class="field">Benutzername<input type="text" name="username" value="${esc(username || '')}" autocomplete="username" autofocus required></label>
<label class="field">Passwort<input type="password" name="password" autocomplete="current-password" required></label>
<button class="btn btn-primary btn-block" type="submit">Anmelden</button>
</form></div>`,
  });
}

export function messagePage({ title, message, user, csrf, kind = 'bad' }) {
  return layout({
    title,
    user,
    csrf,
    narrow: true,
    body: `<div class="card"><h1>${esc(title)}</h1><div class="alert ${kind}">${message}</div><a class="btn btn-secondary" href="/">Zur Übersicht</a></div>`,
  });
}

function permissionItems({ ceiling, selected, namePrefix = 'perm' }) {
  const groups = [
    ['fredy', 'Was Fredy selbst anbietet'],
    ['bridge', 'Zusätze der Bridge (Opt-in)'],
  ];
  return groups
    .map(([source, heading]) => {
      const items = PERMISSIONS.filter((p) => p.source === source)
        .map((p) => {
          const allowed = ceiling.includes(p.key);
          const checked = allowed && selected.includes(p.key);
          return `<li class="${allowed ? '' : 'locked'} ${p.danger ? 'danger' : ''}"><label>
<input type="checkbox" name="${namePrefix}" value="${esc(p.key)}" ${checked ? 'checked' : ''} ${allowed ? '' : 'disabled'}>
<span><span class="title">${esc(p.label)}</span><br><span class="desc">${esc(p.description)}${
            allowed ? '' : ' <strong>Für deine Rolle von einem Admin gesperrt.</strong>'
          }</span></span></label></li>`;
        })
        .join('');
      return `<div class="section-label">${heading}</div><ul class="perms">${items}</ul>`;
    })
    .join('');
}

export function consentPage({ user, csrf, pending, ceiling, selected, existing }) {
  const clientName = pending.client.client_name || 'Unbekannter Client';
  const host = new URL(pending.redirectUri).host;
  return layout({
    title: 'Verbindung freigeben',
    user,
    csrf,
    narrow: true,
    body: `<div class="card"><h1>Verbindung freigeben</h1>
<p class="lead"><strong>${esc(clientName)}</strong> möchte sich mit deinem Fredy-Konto <strong>${esc(user.username)}</strong> verbinden.<br>
<span class="small">Weiterleitung an <span class="mono">${esc(host)}</span></span></p>
${existing ? '<div class="alert warn">Dieser Client ist bereits verbunden. Die Auswahl unten ersetzt die bisherigen Rechte.</div>' : ''}
<form method="post" action="/consent">
<input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="req" value="${esc(pending.id)}">
${permissionItems({ ceiling, selected })}
<p class="small muted">Du kannst die Rechte später jederzeit ändern, einzelne Fredy-Tools sperren oder die Verbindung trennen.</p>
<button class="btn btn-primary btn-block" type="submit" name="action" value="allow">Verbinden</button>
<button class="btn btn-secondary btn-block" style="margin-top:8px" type="submit" name="action" value="deny">Abbrechen</button>
</form></div>`,
  });
}

function permissionChips(grant, ceiling) {
  const granted = new Set(JSON.parse(grant.permissions));
  const chips = PERMISSIONS.filter((p) => granted.has(p.key)).map((p) => {
    const active = ceiling.includes(p.key);
    return `<span class="chip ${active ? '' : 'off'}" title="${active ? '' : 'Durch die Rollen-Obergrenze derzeit gesperrt'}">${esc(p.label)}</span>`;
  });
  const blocked = JSON.parse(grant.blocked_tools || '[]');
  if (blocked.length) chips.push(`<span class="chip off">${blocked.length} Fredy-Tool(s) gesperrt</span>`);
  return chips.join('') || '<span class="muted small">keine Rechte</span>';
}

function connectionBlock(grant, ceiling, csrf, showUser) {
  return `<div class="conn"><div class="spread"><div>
<strong>${esc(grant.client_name)}</strong>${showUser ? ` <span class="chip">${esc(grant.username)}</span>` : ''}<br>
<span class="small muted">${grant.redirect_host ? `${esc(grant.redirect_host)} · ` : ''}verbunden ${esc(fmtDate(grant.created_at))} · zuletzt genutzt ${esc(
    fmtDate(grant.last_used_at),
  )}</span></div>
<div class="row"><a class="btn btn-secondary btn-sm" href="/connections/${esc(grant.id)}">Rechte bearbeiten</a>
<form method="post" action="/connections/${esc(grant.id)}/revoke" style="margin:0" onsubmit="return confirm('Verbindung wirklich trennen? Der Client verliert sofort den Zugriff.')">
<input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn btn-danger btn-sm" type="submit">Trennen</button></form></div></div>
<div style="margin-top:8px">${permissionChips(grant, ceiling)}</div></div>`;
}

function statusList(checks) {
  const icon = { ok: '&#10003;', warn: '!', bad: '&#10007;' };
  return `<ul class="status small" style="padding-left:0;list-style:none;margin:0">${checks
    .map((c) => `<li><span class="${c.state}">${icon[c.state]}</span> <strong>${esc(c.name)}</strong> – ${esc(c.message)}</li>`)
    .join('')}</ul>`;
}

export function dashboardPage({ user, csrf, mcpUrl, myGrants, otherGrants, ceilings, proxyOk, checks, flash }) {
  const mine = myGrants.length
    ? myGrants.map((g) => connectionBlock(g, ceilings[user.isAdmin ? 'admin' : 'user'], csrf, false)).join('')
    : '<p class="muted">Noch keine Verbindung. Füge die URL oben in deinem MCP-Client hinzu.</p>';

  const adminCards = user.isAdmin
    ? `<div class="card"><div class="spread"><h2>Verbindungen anderer Benutzer</h2></div>${
        otherGrants.length
          ? otherGrants.map((g) => connectionBlock(g, ceilings[g.isAdmin ? 'admin' : 'user'], csrf, true)).join('')
          : '<p class="muted">Keine.</p>'
      }</div>
<div class="card"><div class="spread"><h2>Rollen-Obergrenzen</h2><a class="btn btn-secondary btn-sm" href="/admin/roles">Bearbeiten</a></div>
<p class="small muted">Legt fest, welche Rechte Admins und Benutzer für ihre Verbindungen überhaupt freigeben dürfen.</p></div>
<div class="card"><h2>Zustand</h2>${statusList(checks)}</div>`
    : '';

  return layout({
    title: 'Übersicht',
    user,
    csrf,
    body: `${flash ? `<div class="alert ok">${esc(flash)}</div>` : ''}
${
  proxyOk === false
    ? `<div class="alert bad">Fredy bestätigt deinen Benutzer nicht über die Reverse-Proxy-Anmeldung. Tools funktionieren erst, wenn sie in Fredy eingerichtet ist${
        user.isAdmin ? ' – siehe „Zustand“ unten.' : '. Bitte wende dich an einen Admin.'
      }</div>`
    : ''
}
<div class="card"><h1>Connector-URL</h1>
<p class="lead">Diese Adresse in deinem MCP-Client eintragen – in Claude unter <em>Einstellungen → Connectors → Benutzerdefinierten Connector hinzufügen</em>. Danach landest du hier zur Freigabe.</p>
<div class="copy"><input type="text" id="mcpurl" value="${esc(mcpUrl)}" readonly>
<button class="btn btn-primary" type="button" onclick="navigator.clipboard.writeText(document.getElementById('mcpurl').value);this.textContent='Kopiert'">Kopieren</button></div></div>
<div class="card"><h2>Meine Verbindungen</h2>${mine}</div>
${adminCards}`,
  });
}

export function connectionPage({ user, csrf, grant, ceiling, upstreamTools, upstreamError, permissionFor }) {
  const selected = JSON.parse(grant.permissions);
  const blocked = new Set(JSON.parse(grant.blocked_tools || '[]'));
  let toolsHtml;
  if (upstreamError) {
    toolsHtml = `<div class="alert warn">Fredys Tool-Liste ist gerade nicht abrufbar: ${esc(upstreamError)}</div>`;
  } else {
    const rows = (perm) =>
      upstreamTools
        .filter((t) => permissionFor(t) === perm)
        .map(
          (t) => `<li><label><input type="checkbox" name="tool" value="${esc(t.name)}" ${blocked.has(t.name) ? '' : 'checked'}>
<span><span class="title mono">${esc(t.name)}</span><br><span class="desc">${esc(t.annotations?.title || t.title || '')}${
            t.annotations?.destructiveHint ? ' · überschreibt Daten' : ''
          }</span></span></label></li>`,
        )
        .join('') || '<li class="muted small">keine</li>';
    toolsHtml = `<p class="small muted">Gilt zusätzlich zu den Rechten oben. Neue Tools, die Fredy künftig mitbringt, sind automatisch erlaubt, solange die passende Fredy-Berechtigung an ist.</p>
<div class="section-label">Lesen</div><ul class="perms">${rows('fredy.read')}</ul>
<div class="section-label">Schreiben</div><ul class="perms">${rows('fredy.write')}</ul>`;
  }

  return layout({
    title: 'Rechte bearbeiten',
    user,
    csrf,
    body: `<div class="card"><h1>${esc(grant.client_name)}</h1>
<p class="lead">Fredy-Konto <strong>${esc(grant.username)}</strong>${grant.redirect_host ? ` · ${esc(grant.redirect_host)}` : ''}. Änderungen gelten ab dem nächsten Tool-Aufruf.</p>
<form method="post" action="/connections/${esc(grant.id)}">
<input type="hidden" name="_csrf" value="${esc(csrf)}">
${permissionItems({ ceiling, selected })}
<h2 style="margin-top:24px">Einzelne Fredy-Tools</h2>
${toolsHtml}
<input type="hidden" name="toolsShown" value="${upstreamError ? '0' : '1'}">
<div class="row"><button class="btn btn-primary" type="submit">Speichern</button><a class="btn btn-secondary" href="/">Zurück</a></div>
</form></div>`,
  });
}

export function rolesPage({ user, csrf, policies }) {
  const rows = PERMISSIONS.map(
    (p) => `<tr><td><strong>${esc(p.label)}</strong><br><span class="small muted">${esc(p.source === 'fredy' ? 'Fredy' : 'Bridge-Zusatz')}</span></td>
${Object.keys(ROLES)
  .map((role) => `<td class="c"><input type="checkbox" name="${role}" value="${esc(p.key)}" ${policies[role].includes(p.key) ? 'checked' : ''}></td>`)
  .join('')}</tr>`,
  ).join('');
  return layout({
    title: 'Rollen-Obergrenzen',
    user,
    csrf,
    body: `<div class="card"><h1>Rollen-Obergrenzen</h1>
<p class="lead">Was Mitglieder einer Fredy-Rolle für ihre Verbindungen höchstens freigeben dürfen. Wird eine Berechtigung hier entzogen, ist sie sofort in allen Verbindungen dieser Rolle aus – die Auswahl der Benutzer bleibt aber gespeichert und greift wieder, wenn du sie zurückgibst.</p>
<form method="post" action="/admin/roles"><input type="hidden" name="_csrf" value="${esc(csrf)}">
<table><thead><tr><th>Berechtigung</th>${Object.values(ROLES).map((r) => `<th class="c">${esc(r)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
<p class="small muted">Unabhängig davon sieht und ändert jeder Benutzer nur, was Fredy ihm erlaubt (eigene und mit ihm geteilte Jobs).</p>
<div class="row"><button class="btn btn-primary" type="submit">Speichern</button><a class="btn btn-secondary" href="/">Zurück</a></div>
</form></div>`,
  });
}
