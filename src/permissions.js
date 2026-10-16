/*
 * Berechtigungen einer Verbindung.
 *
 * Regeln:
 * - Was Fredy selbst per MCP anbietet, ist beim Verbinden standardmäßig an – auch Tools, die
 *   upstream später dazukommen. Einzelne Fredy-Tools lassen sich pro Verbindung sperren.
 * - Alles, was die Bridge zusätzlich mitbringt, ist standardmäßig aus (Opt-in).
 * - Pro Fredy-Rolle (Admin / Benutzer) legt ein Admin eine Obergrenze fest. Wirksam ist immer
 *   Verbindung ∩ Obergrenze der Rolle, die der Benutzer *jetzt gerade* in Fredy hat.
 * - Was ein Benutzer in Fredy sehen und ändern darf, entscheidet weiterhin Fredy selbst.
 */

export const PERMISSIONS = [
  {
    key: 'fredy.read',
    source: 'fredy',
    label: 'Fredy: Lesen',
    description: 'Suchjobs, Inserate, Fotos, Anschreiben, Finanzierungsrechner – alle Fredy-Tools, die nur lesen.',
    defaultOn: true,
  },
  {
    key: 'fredy.write',
    source: 'fredy',
    label: 'Fredy: Schreiben',
    description:
      'Fredys eigene Schreib-Tools: Notizen, Merkliste, Suchjobs per Interview anlegen – und was Fredy künftig ergänzt.',
    defaultOn: true,
  },
  {
    key: 'listings.hide',
    source: 'bridge',
    label: 'Inserate löschen (ausblenden) & wiederherstellen',
    description:
      'Wie „Löschen“ in der Fredy-Oberfläche: Das Inserat verschwindet und kommt beim nächsten Suchlauf nicht wieder. Jederzeit rückgängig zu machen.',
    defaultOn: false,
  },
  {
    key: 'listings.hard_delete',
    source: 'bridge',
    label: 'Inserate endgültig löschen',
    description:
      'Entfernt Inserate unwiderruflich aus der Datenbank. Ist das Inserat noch online, meldet Fredy es beim nächsten Lauf erneut als neu.',
    defaultOn: false,
    danger: true,
  },
  {
    key: 'listings.status',
    source: 'bridge',
    label: 'Bewerbungsstatus setzen',
    description: 'Inserate als beworben, abgesagt oder zugesagt markieren – oder den Status entfernen.',
    defaultOn: false,
  },
  {
    key: 'listings.scam',
    source: 'bridge',
    label: 'Betrugsverdacht markieren',
    description: 'Inserate als Betrug oder als unbedenklich einstufen – oder die Einstufung zurücknehmen.',
    defaultOn: false,
  },
  {
    key: 'jobs.run',
    source: 'bridge',
    label: 'Suchjobs sofort starten',
    description: 'Einen Suchlauf außerhalb des Zeitplans auslösen.',
    defaultOn: false,
  },
  {
    key: 'jobs.toggle',
    source: 'bridge',
    label: 'Suchjobs aktivieren & pausieren',
    description: 'Suchjobs ein- oder ausschalten.',
    defaultOn: false,
  },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
const KNOWN = new Set(PERMISSION_KEYS);

export const ROLES = {
  admin: 'Admins',
  user: 'Benutzer',
};

/** Ausgangswerte der Rollen-Obergrenzen, solange ein Admin nichts anderes eingestellt hat. */
export const DEFAULT_ROLE_POLICIES = {
  admin: [...PERMISSION_KEYS],
  user: ['fredy.read', 'fredy.write', 'listings.hide', 'listings.status', 'listings.scam'],
};

export function sanitizePermissions(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((key) => KNOWN.has(key)))];
}

export function defaultPermissions(ceiling) {
  return PERMISSIONS.filter((p) => p.defaultOn && ceiling.includes(p.key)).map((p) => p.key);
}

export function roleOf(identity) {
  return identity?.isAdmin ? 'admin' : 'user';
}

export function getRolePolicy(db, role) {
  const row = db.prepare('SELECT allowed FROM role_policies WHERE role = ?').get(role);
  return row ? sanitizePermissions(JSON.parse(row.allowed)) : [...DEFAULT_ROLE_POLICIES[role]];
}

export function setRolePolicy(db, role, allowed) {
  if (!ROLES[role]) throw new Error(`Unbekannte Rolle ${role}`);
  db.prepare(
    'INSERT INTO role_policies (role, allowed) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET allowed = excluded.allowed',
  ).run(role, JSON.stringify(sanitizePermissions(allowed)));
}

/** Was eine Verbindung jetzt gerade darf. */
export function effectivePermissions(db, grant, identity) {
  const ceiling = new Set(getRolePolicy(db, roleOf(identity)));
  const granted = sanitizePermissions(JSON.parse(grant.permissions));
  return new Set(granted.filter((key) => ceiling.has(key)));
}

/** Welche Berechtigung braucht ein durchgereichtes Fredy-Tool? */
export function permissionForFredyTool(tool) {
  return tool?.annotations?.readOnlyHint === true ? 'fredy.read' : 'fredy.write';
}
