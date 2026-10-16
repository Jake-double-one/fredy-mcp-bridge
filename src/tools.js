/*
 * Die zusätzlichen Tools der Bridge. Jedes ruft genau den REST-Endpunkt auf, den auch Fredys
 * Web-Oberfläche benutzt – im Namen des verbundenen Benutzers. Eigentümer-Prüfung,
 * „alles oder nichts“ bei fremden IDs und Demo-Modus erledigt Fredy.
 *
 * Bringt Fredy irgendwann ein gleichnamiges Tool selbst mit, gewinnt Fredys Version und das
 * Bridge-Tool wird automatisch ausgeblendet.
 */

import { UPDATE_SCHEMA, mergeProfile, validateUpdate } from './finance.js';

const idList = {
  type: 'array',
  items: { type: 'string', minLength: 1 },
  minItems: 1,
  maxItems: 500,
  description: 'Listing ids as returned by list_listings / get_listing (the "id" field).',
};

const HIDDEN_FIELDS = ['id', 'title', 'price', 'size', 'rooms', 'address', 'provider', 'link', 'job_name', 'created_at'];

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function failure(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function fredyFailure(status, data, fallback) {
  const detail = data?.message || data?.error || (typeof data === 'string' ? data : null);
  if (status === 401) {
    return failure('Fredy did not accept the bridge sign-in for this user (HTTP 401). Ask the admin to check the reverse-proxy sign-in settings in Fredy.');
  }
  return failure(`${fallback} Fredy answered HTTP ${status}${detail ? `: ${detail}` : '.'}`);
}

function requireString(args, name) {
  const value = args?.[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`"${name}" is required.`);
  return value.trim();
}

function requireIds(args) {
  const ids = args?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || id === '')) {
    throw new Error('"ids" must be a non-empty list of listing ids.');
  }
  if (ids.length > 500) throw new Error('At most 500 ids per call.');
  return [...new Set(ids)];
}

export const BRIDGE_TOOLS = [
  {
    name: 'hide_listings',
    permission: 'listings.hide',
    definition: {
      title: 'Delete (hide) listings',
      description:
        'Delete listings the same way the Fredy web UI does: they disappear from all lists and are NOT reported again by future searches. ' +
        'Use this whenever the user asks to delete, remove or hide listings. Reversible with restore_listings. ' +
        'All-or-nothing: if any id is not accessible to the user, nothing is changed.',
      inputSchema: { type: 'object', properties: { ids: idList }, required: ['ids'], additionalProperties: false },
      annotations: { title: 'Delete (hide) listings', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      const ids = requireIds(args);
      const { status, data } = await fredy.asUser(username, 'DELETE', '/api/listings', { ids, hardDelete: false });
      if (status !== 200) return fredyFailure(status, data, 'Could not hide the listings.');
      return text(`Hidden ${ids.length} listing(s). They will not come back with future searches; use restore_listings to undo.`);
    },
  },
  {
    name: 'list_hidden_listings',
    permission: 'listings.hide',
    definition: {
      title: 'List hidden listings',
      description: 'List listings that were deleted (hidden) earlier, e.g. to find ids for restore_listings.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional free-text filter (title, address, …).' },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'List hidden listings', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      const page = Number.isInteger(args?.page) && args.page > 0 ? args.page : 1;
      const pageSize = Number.isInteger(args?.pageSize) ? Math.min(100, Math.max(1, args.pageSize)) : 25;
      const params = new URLSearchParams({ hiddenOnly: 'true', page: String(page), pageSize: String(pageSize) });
      if (typeof args?.query === 'string' && args.query.trim()) params.set('freeTextFilter', args.query.trim());
      const { status, data } = await fredy.asUser(username, 'GET', `/api/listings/table?${params}`);
      if (status !== 200) return fredyFailure(status, data, 'Could not list hidden listings.');
      const listings = (data?.result || []).map((row) =>
        Object.fromEntries(HIDDEN_FIELDS.filter((key) => row[key] != null).map((key) => [key, row[key]])),
      );
      return text({ total: data?.totalNumber ?? listings.length, page, pageSize, listings });
    },
  },
  {
    name: 'restore_listings',
    permission: 'listings.hide',
    definition: {
      title: 'Restore hidden listings',
      description: 'Bring back listings that were deleted (hidden) with hide_listings or in the Fredy web UI.',
      inputSchema: { type: 'object', properties: { ids: idList }, required: ['ids'], additionalProperties: false },
      annotations: { title: 'Restore hidden listings', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      const ids = requireIds(args);
      const { status, data } = await fredy.asUser(username, 'POST', '/api/listings/restore', { ids });
      if (status !== 200) return fredyFailure(status, data, 'Could not restore the listings.');
      return text(`Restored ${ids.length} listing(s).`);
    },
  },
  {
    name: 'delete_listings_permanently',
    permission: 'listings.hard_delete',
    definition: {
      title: 'Delete listings permanently',
      description:
        'Irreversibly remove listings from the database. WARNING: if a listing is still online, Fredy will report it again as NEW on the next search. ' +
        'Only use this when the user explicitly asks for permanent deletion; for normal deleting use hide_listings. Requires confirm=true.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: idList,
          confirm: { type: 'boolean', description: 'Must be true. Ask the user for explicit confirmation first.' },
        },
        required: ['ids', 'confirm'],
        additionalProperties: false,
      },
      annotations: { title: 'Delete listings permanently', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      const ids = requireIds(args);
      if (args?.confirm !== true) return failure('Not deleted: confirm must be true. Ask the user to confirm permanent deletion.');
      const { status, data } = await fredy.asUser(username, 'DELETE', '/api/listings', { ids, hardDelete: true });
      if (status !== 200) return fredyFailure(status, data, 'Could not delete the listings.');
      return text(`Permanently deleted ${ids.length} listing(s).`);
    },
  },
  {
    name: 'set_listing_status',
    permission: 'listings.status',
    definition: {
      title: 'Set application status',
      description: 'Set the application status of a listing: applied, rejected or accepted. Pass null to clear it.',
      inputSchema: {
        type: 'object',
        properties: {
          listingId: { type: 'string', minLength: 1 },
          status: { type: ['string', 'null'], enum: ['applied', 'rejected', 'accepted', null] },
        },
        required: ['listingId', 'status'],
        additionalProperties: false,
      },
      annotations: { title: 'Set application status', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      const listingId = requireString(args, 'listingId');
      const status = args?.status ?? null;
      if (status !== null && !['applied', 'rejected', 'accepted'].includes(status)) {
        return failure('status must be applied, rejected, accepted or null.');
      }
      const res = await fredy.asUser(username, 'POST', `/api/listings/${encodeURIComponent(listingId)}/status`, { status });
      if (res.status !== 200) return fredyFailure(res.status, res.data, 'Could not set the status.');
      return text(status ? `Status set to "${status}".` : 'Status cleared.');
    },
  },
  {
    name: 'set_listing_scam',
    permission: 'listings.scam',
    definition: {
      title: 'Mark listing as scam or safe',
      description: 'Override Fredy\'s scam detection for a listing: "scam" or "safe". Pass null to hand it back to the detector.',
      inputSchema: {
        type: 'object',
        properties: {
          listingId: { type: 'string', minLength: 1 },
          verdict: { type: ['string', 'null'], enum: ['scam', 'safe', null] },
        },
        required: ['listingId', 'verdict'],
        additionalProperties: false,
      },
      annotations: { title: 'Mark listing as scam or safe', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      const listingId = requireString(args, 'listingId');
      const verdict = args?.verdict ?? null;
      if (verdict !== null && !['scam', 'safe'].includes(verdict)) return failure('verdict must be scam, safe or null.');
      const res = await fredy.asUser(username, 'POST', `/api/listings/${encodeURIComponent(listingId)}/scam`, { override: verdict });
      if (res.status !== 200) return fredyFailure(res.status, res.data, 'Could not update the scam verdict.');
      return text(verdict ? `Marked as "${verdict}".` : 'Scam verdict cleared.');
    },
  },
  {
    name: 'run_job',
    permission: 'jobs.run',
    definition: {
      title: 'Run search job now',
      description: 'Start a search job immediately, outside its schedule. Use list_jobs to find the job id.',
      inputSchema: { type: 'object', properties: { jobId: { type: 'string', minLength: 1 } }, required: ['jobId'], additionalProperties: false },
      annotations: { title: 'Run search job now', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async run(fredy, username, args) {
      const jobId = requireString(args, 'jobId');
      const res = await fredy.asUser(username, 'POST', `/api/jobs/${encodeURIComponent(jobId)}/run`);
      if (res.status !== 202 && res.status !== 200) return fredyFailure(res.status, res.data, 'Could not start the job.');
      return text('Job run started. New listings will show up once the run has finished.');
    },
  },
  {
    name: 'set_job_enabled',
    permission: 'jobs.toggle',
    definition: {
      title: 'Enable or pause search job',
      description: 'Switch a search job on (enabled=true) or pause it (enabled=false).',
      inputSchema: {
        type: 'object',
        properties: { jobId: { type: 'string', minLength: 1 }, enabled: { type: 'boolean' } },
        required: ['jobId', 'enabled'],
        additionalProperties: false,
      },
      annotations: { title: 'Enable or pause search job', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      const jobId = requireString(args, 'jobId');
      if (typeof args?.enabled !== 'boolean') return failure('enabled must be true or false.');
      const res = await fredy.asUser(username, 'PUT', `/api/jobs/${encodeURIComponent(jobId)}/status`, { status: args.enabled });
      if (res.status !== 200) return fredyFailure(res.status, res.data, 'Could not change the job.');
      return text(args.enabled ? 'Job enabled.' : 'Job paused.');
    },
  },
  {
    name: 'get_finance_profile',
    permission: 'finance.read',
    definition: {
      title: 'Get finance profile',
      description:
        "Read the user's finance profile from Fredy's financing calculator: household (net incomes, living costs, existing loans), " +
        'rent settings, purchase settings (price, equity, state, closing-cost rates) and loan scenarios. ' +
        '"saved" is what the user stored, "effective" includes Fredy\'s defaults for anything not stored. ' +
        'Also returns the computed monthly budget and whether the profile is complete for buying and for renting.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Get finance profile', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username) {
      const settings = await fredy.asUser(username, 'GET', '/api/user/settings');
      if (settings.status !== 200) return fredyFailure(settings.status, settings.data, 'Could not read the finance profile.');
      const summary = await fredy.asUser(username, 'GET', '/api/finance/profile-summary');
      if (summary.status !== 200) return fredyFailure(summary.status, summary.data, 'Could not read the finance summary.');
      return text({
        saved: settings.data?.finance_profile ?? null,
        effective: summary.data?.profile,
        budget: summary.data?.budget,
        thresholds: summary.data?.thresholds,
        completeForBuying: summary.data?.isComplete,
        completeForRenting: summary.data?.rentComplete,
      });
    },
  },
  {
    name: 'update_finance_profile',
    permission: 'finance.write',
    definition: {
      title: 'Update finance profile',
      description:
        "Change the user's finance profile in Fredy (the same settings as on Fredy's financing page). " +
        'Pass ONLY the fields that should change – everything else stays as it is. All amounts are EUR, incomes and costs are MONTHLY NET values, rates are percent. ' +
        'scenarios is the complete list of loan scenarios and replaces the stored one. ' +
        'Changing bundesland resets the transfer tax to that state\'s rate unless grunderwerbsteuerPct is given. ' +
        'If any field is invalid, nothing is saved and every problem is reported. Call get_finance_profile first when unsure about the current values. ' +
        'These values drive Fredy\'s affordability verdicts and filters.',
      inputSchema: UPDATE_SCHEMA,
      annotations: { title: 'Update finance profile', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      const errors = validateUpdate(args);
      if (errors.length) return failure(`Nothing was saved:\n- ${errors.join('\n- ')}`);
      const settings = await fredy.asUser(username, 'GET', '/api/user/settings');
      if (settings.status !== 200) return fredyFailure(settings.status, settings.data, 'Could not read the finance profile.');
      const next = mergeProfile(settings.data?.finance_profile ?? null, args);
      const saved = await fredy.asUser(username, 'POST', '/api/user/settings/finance-profile', { finance_profile: next });
      if (saved.status !== 200) return fredyFailure(saved.status, saved.data, 'Could not save the finance profile.');
      const summary = await fredy.asUser(username, 'GET', '/api/finance/profile-summary');
      return text({
        saved: true,
        changed: Object.keys(args),
        effective: summary.data?.profile,
        budget: summary.data?.budget,
        completeForBuying: summary.data?.isComplete,
        completeForRenting: summary.data?.rentComplete,
      });
    },
  },
];

export const BRIDGE_TOOL_NAMES = new Set(BRIDGE_TOOLS.map((t) => t.name));
