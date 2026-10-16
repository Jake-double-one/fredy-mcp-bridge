/*
 * Server-seitig gerenderte Seiten. Kein Build-Schritt, kein externes Asset.
 * Jede Seite bekommt einen Übersetzer `i` ({ lang, locale, t }) aus i18n.js.
 */

import { PERMISSIONS, ROLES } from './permissions.js';
import { DETAILS_PER_HOUR } from './tools.js';
import { grantName } from './db.js';

// Werte, die in Berechtigungstexten als Platzhalter vorkommen.
const PERM_VARS = { perHour: String(DETAILS_PER_HOUR) };

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Übersetzung als HTML: Text wird escaped, Platzhalter bekommen bereits fertiges (escaptes) HTML. */
function th(i, key, html = {}) {
  return esc(i.t(key)).replace(/\{\{(\w+)\}\}/g, (match, name) => (html[name] !== undefined ? html[name] : match));
}

function fmtDate(i, seconds) {
  if (!seconds) return i.t('common.never');
  return new Date(seconds * 1000).toLocaleString(i.locale, {
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
.copy input{flex:1;margin:0;min-width:0}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
td.c,th.c{text-align:center}
td input{width:17px;height:17px;accent-color:var(--accent)}
.status li{margin-bottom:6px}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.conn+.conn{border-top:1px solid var(--line);padding-top:16px;margin-top:16px}
footer{text-align:center;color:var(--muted);font-size:12px;padding:20px}
`;

export function layout(i, { title, body, user, csrf, narrow = false }) {
  const who = user
    ? `<div class="who"><span>${esc(user.username)}</span>${user.isAdmin ? `<span class="chip admin">${th(i, 'layout.admin')}</span>` : ''}
       <form method="post" action="/logout" style="margin:0"><input type="hidden" name="_csrf" value="${esc(csrf)}">
       <button class="btn btn-secondary btn-sm" type="submit">${th(i, 'layout.signOut')}</button></form></div>`
    : '';
  return `<!doctype html><html lang="${esc(i.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Fredy MCP Bridge</title><style>${CSS}</style></head>
<body><header><a class="brand" href="/"><span class="heart">&#10084;</span> Fredy MCP Bridge</a>${who}</header>
<main class="${narrow ? 'narrow' : ''}">${body}</main>
<footer>${th(i, 'layout.footer')}</footer></body></html>`;
}

export function loginPage(i, { error, next, username }) {
  return layout(i, {
    title: i.t('login.title'),
    narrow: true,
    body: `<div class="card"><h1>${th(i, 'login.title')}</h1><p class="lead">${th(i, 'login.lead')}</p>
${error ? `<div class="alert bad">${esc(error)}</div>` : ''}
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next || '/')}">
<label class="field">${th(i, 'login.username')}<input type="text" name="username" value="${esc(username || '')}" autocomplete="username" autofocus required></label>
<label class="field">${th(i, 'login.password')}<input type="password" name="password" autocomplete="current-password" required></label>
<button class="btn btn-primary btn-block" type="submit">${th(i, 'login.button')}</button>
</form></div>`,
  });
}

export function messagePage(i, { title, message, user, csrf, kind = 'bad' }) {
  return layout(i, {
    title,
    user,
    csrf,
    narrow: true,
    body: `<div class="card"><h1>${esc(title)}</h1><div class="alert ${kind}">${esc(message)}</div><a class="btn btn-secondary" href="/">${th(i, 'common.toOverview')}</a></div>`,
  });
}

function permissionItems(i, { ceiling, selected }) {
  return ['fredy', 'bridge']
    .map((source) => {
      const items = PERMISSIONS.filter((p) => p.source === source)
        .map((p) => {
          const allowed = ceiling.includes(p.key);
          const checked = allowed && selected.includes(p.key);
          return `<li class="${allowed ? '' : 'locked'} ${p.danger ? 'danger' : ''}"><label>
<input type="checkbox" name="perm" value="${esc(p.key)}" ${checked ? 'checked' : ''} ${allowed ? '' : 'disabled'}>
<span><span class="title">${th(i, `perm.${p.key}.label`)}</span><br><span class="desc">${th(i, `perm.${p.key}.desc`, PERM_VARS)}${
            allowed ? '' : ` <strong>${th(i, 'perm.lockedByRole')}</strong>`
          }</span></span></label></li>`;
        })
        .join('');
      return `<div class="section-label">${th(i, `perm.group.${source}`)}</div><ul class="perms">${items}</ul>`;
    })
    .join('');
}

export function consentPage(i, { user, csrf, pending, ceiling, selected, existing }) {
  const clientName = pending.client.client_name || i.t('consent.unknownClient');
  const host = new URL(pending.redirectUri).host;
  return layout(i, {
    title: i.t('consent.title'),
    user,
    csrf,
    narrow: true,
    body: `<div class="card"><h1>${th(i, 'consent.title')}</h1>
<p class="lead">${th(i, 'consent.lead', { client: `<strong>${esc(clientName)}</strong>`, user: `<strong>${esc(user.username)}</strong>` })}<br>
<span class="small">${th(i, 'consent.redirect', { host: `<span class="mono">${esc(host)}</span>` })}</span></p>
${existing ? `<div class="alert warn">${th(i, 'consent.existing')}</div>` : ''}
<form method="post" action="/consent">
<input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="req" value="${esc(pending.id)}">
${permissionItems(i, { ceiling, selected })}
<p class="small muted">${th(i, 'consent.footnote')}</p>
<button class="btn btn-primary btn-block" type="submit" name="action" value="allow">${th(i, 'consent.connect')}</button>
<button class="btn btn-secondary btn-block" style="margin-top:8px" type="submit" name="action" value="deny">${th(i, 'consent.cancel')}</button>
</form></div>`,
  });
}

function permissionChips(i, grant, ceiling) {
  const granted = new Set(JSON.parse(grant.permissions));
  const chips = PERMISSIONS.filter((p) => granted.has(p.key)).map((p) => {
    const active = ceiling.includes(p.key);
    return `<span class="chip ${active ? '' : 'off'}" title="${active ? '' : th(i, 'conn.lockedByCeiling')}">${th(i, `perm.${p.key}.label`)}</span>`;
  });
  const blocked = JSON.parse(grant.blocked_tools || '[]');
  if (blocked.length) chips.push(`<span class="chip off">${th(i, 'conn.blockedTools', { count: String(blocked.length) })}</span>`);
  return chips.join('') || `<span class="muted small">${th(i, 'conn.noPermissions')}</span>`;
}

function connectionBlock(i, grant, ceiling, csrf, showUser) {
  const meta = [
    grant.redirect_host ? esc(grant.redirect_host) : null,
    th(i, 'conn.connectedAt', { date: esc(fmtDate(i, grant.created_at)) }),
    th(i, 'conn.lastUsed', { date: esc(fmtDate(i, grant.last_used_at)) }),
  ]
    .filter(Boolean)
    .join(' · ');
  // confirm() bekommt den Text als JSON-String; im Attribut zusätzlich HTML-escaped.
  const confirmText = esc(JSON.stringify(i.t('conn.revokeConfirm')));
  return `<div class="conn"><div class="spread"><div>
<strong>${esc(grantName(grant))}</strong>${showUser ? ` <span class="chip">${esc(grant.username)}</span>` : ''}<br>
${grant.custom_name ? `<span class="small muted">${th(i, 'conn.clientName', { client: esc(grant.client_name) })}</span><br>` : ''}
<span class="small muted">${meta}</span></div>
<div class="row"><a class="btn btn-secondary btn-sm" href="/connections/${esc(grant.id)}">${th(i, 'conn.edit')}</a>
<form method="post" action="/connections/${esc(grant.id)}/revoke" style="margin:0" onsubmit="return confirm(${confirmText})">
<input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn btn-danger btn-sm" type="submit">${th(i, 'conn.revoke')}</button></form></div></div>
<div style="margin-top:8px">${permissionChips(i, grant, ceiling)}</div></div>`;
}

function statusList(i, checks) {
  const icon = { ok: '&#10003;', warn: '!', bad: '&#10007;' };
  return `<ul class="status small" style="padding-left:0;list-style:none;margin:0">${checks
    .map((c) => `<li><span class="${c.state}">${icon[c.state]}</span> <strong>${th(i, c.name)}</strong> – ${esc(c.raw ?? i.t(c.message, c.vars))}</li>`)
    .join('')}</ul>`;
}

export function dashboardPage(i, { user, csrf, mcpUrl, myGrants, otherGrants, ceilings, proxyOk, checks, flash }) {
  const mine = myGrants.length
    ? myGrants.map((g) => connectionBlock(i, g, ceilings[user.isAdmin ? 'admin' : 'user'], csrf, false)).join('')
    : `<p class="muted">${th(i, 'dash.mineEmpty')}</p>`;

  const adminCards = user.isAdmin
    ? `<div class="card"><h2>${th(i, 'dash.others')}</h2>${
        otherGrants.length
          ? otherGrants.map((g) => connectionBlock(i, g, ceilings[g.isAdmin ? 'admin' : 'user'], csrf, true)).join('')
          : `<p class="muted">${th(i, 'dash.othersEmpty')}</p>`
      }</div>
<div class="card"><div class="spread"><h2>${th(i, 'dash.roles')}</h2><a class="btn btn-secondary btn-sm" href="/admin/roles">${th(i, 'dash.rolesEdit')}</a></div>
<p class="small muted">${th(i, 'dash.rolesDesc')}</p></div>
<div class="card"><h2>${th(i, 'dash.status')}</h2>${statusList(i, checks)}</div>`
    : '';

  const copied = esc(JSON.stringify(i.t('dash.copied')));
  return layout(i, {
    title: i.t('dash.title'),
    user,
    csrf,
    body: `${flash ? `<div class="alert ok">${th(i, flash)}</div>` : ''}
${
  proxyOk === false
    ? `<div class="alert bad">${th(i, 'dash.proxyWarning')} ${th(i, user.isAdmin ? 'dash.proxyWarningAdmin' : 'dash.proxyWarningUser')}</div>`
    : ''
}
<div class="card"><h1>${th(i, 'dash.connectorTitle')}</h1>
<p class="lead">${th(i, 'dash.connectorLead', { path: `<em>${th(i, 'dash.connectorPath')}</em>` })}</p>
<div class="copy"><input type="text" id="mcpurl" value="${esc(mcpUrl)}" readonly>
<button class="btn btn-primary" type="button" onclick="navigator.clipboard.writeText(document.getElementById('mcpurl').value);this.textContent=${copied}">${th(i, 'dash.copy')}</button></div></div>
<div class="card"><h2>${th(i, 'dash.mine')}</h2>${mine}</div>
${adminCards}`,
  });
}

export function connectionPage(i, { user, csrf, grant, ceiling, upstreamTools, upstreamError, permissionFor }) {
  const selected = JSON.parse(grant.permissions);
  const blocked = new Set(JSON.parse(grant.blocked_tools || '[]'));
  let toolsHtml;
  if (upstreamError) {
    toolsHtml = `<div class="alert warn">${th(i, 'connPage.toolsUnavailable', { error: esc(upstreamError) })}</div>`;
  } else {
    const rows = (perm) =>
      upstreamTools
        .filter((tool) => permissionFor(tool) === perm)
        .map(
          (tool) => `<li><label><input type="checkbox" name="tool" value="${esc(tool.name)}" ${blocked.has(tool.name) ? '' : 'checked'}>
<span><span class="title mono">${esc(tool.name)}</span><br><span class="desc">${esc(tool.annotations?.title || tool.title || '')}${
            tool.annotations?.destructiveHint ? ` · ${th(i, 'connPage.overwrites')}` : ''
          }</span></span></label></li>`,
        )
        .join('') || `<li class="muted small">${th(i, 'connPage.none')}</li>`;
    toolsHtml = `<p class="small muted">${th(i, 'connPage.toolsNote')}</p>
<div class="section-label">${th(i, 'connPage.read')}</div><ul class="perms">${rows('fredy.read')}</ul>
<div class="section-label">${th(i, 'connPage.write')}</div><ul class="perms">${rows('fredy.write')}</ul>`;
  }

  return layout(i, {
    title: i.t('connPage.title'),
    user,
    csrf,
    body: `<div class="card"><h1>${esc(grantName(grant))}</h1>
<p class="lead">${th(i, 'connPage.lead', { user: `<strong>${esc(grant.username)}</strong>` })}${grant.redirect_host ? ` · ${esc(grant.redirect_host)}` : ''}</p>
<form method="post" action="/connections/${esc(grant.id)}">
<input type="hidden" name="_csrf" value="${esc(csrf)}">
<label class="field">${th(i, 'connPage.nameLabel')}<input type="text" name="name" maxlength="60" value="${esc(grant.custom_name || '')}" placeholder="${esc(grant.client_name)}"></label>
<p class="small muted" style="margin-top:-8px">${th(i, 'connPage.nameHelp', { client: `<strong>${esc(grant.client_name)}</strong>` })}</p>
${permissionItems(i, { ceiling, selected })}
<h2 style="margin-top:24px">${th(i, 'connPage.toolsHeading')}</h2>
${toolsHtml}
<input type="hidden" name="toolsShown" value="${upstreamError ? '0' : '1'}">
<div class="row"><button class="btn btn-primary" type="submit">${th(i, 'common.save')}</button><a class="btn btn-secondary" href="/">${th(i, 'common.back')}</a></div>
</form></div>`,
  });
}

export function rolesPage(i, { user, csrf, policies }) {
  const roles = Object.keys(ROLES);
  const rows = PERMISSIONS.map(
    (p) => `<tr><td><strong>${th(i, `perm.${p.key}.label`)}</strong><br><span class="small muted">${th(
      i,
      p.source === 'fredy' ? 'roles.sourceFredy' : 'roles.sourceBridge',
    )}</span></td>
${roles.map((role) => `<td class="c"><input type="checkbox" name="${role}" value="${esc(p.key)}" ${policies[role].includes(p.key) ? 'checked' : ''}></td>`).join('')}</tr>`,
  ).join('');
  return layout(i, {
    title: i.t('roles.title'),
    user,
    csrf,
    body: `<div class="card"><h1>${th(i, 'roles.title')}</h1>
<p class="lead">${th(i, 'roles.lead')}</p>
<form method="post" action="/admin/roles"><input type="hidden" name="_csrf" value="${esc(csrf)}">
<table><thead><tr><th>${th(i, 'roles.permission')}</th>${roles.map((r) => `<th class="c">${th(i, `roles.${r}`)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
<p class="small muted">${th(i, 'roles.note')}</p>
<div class="row"><button class="btn btn-primary" type="submit">${th(i, 'common.save')}</button><a class="btn btn-secondary" href="/">${th(i, 'common.back')}</a></div>
</form></div>`,
  });
}
