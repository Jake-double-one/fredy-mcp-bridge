/*
 * Weitere Bridge-Tools rund um Fredys Benutzereinstellungen und Inseratsdaten:
 * Preisverlauf, Orte für die Fahrzeitberechnung (Adressen und Ortstypen wie „nächste Schule“),
 * exakte Fahrzeiten sowie Bewerberprofil und Anschreiben-Vorlagen.
 *
 * Wie überall: Jeder Aufruf geht an denselben REST-Endpunkt wie Fredys Oberfläche, im Namen des
 * verbundenen Benutzers. Fredy prüft Zugriff und Demo-Modus.
 */

import { createLimiter, failure, fredyFailure, readUserSettings, requireString, text } from './toolHelpers.js';

// Exakte Fahrzeiten fragen Routing-Dienste an. Fredy rechnet das für „eine Person, ein Inserat“;
// ein Sprachmodell soll daraus keine Massenabfrage machen.
const travelLimiter = createLimiter(Math.max(1, Number(process.env.TRAVEL_TIMES_PER_HOUR) || 30));

const MODES = ['transit', 'car', 'bike', 'walk'];
// Fredys aktuelle Ortstypen (lib/services/poi/categories.js). Nur zur Beschreibung – geprüft wird in
// Fredy selbst, damit neue Typen aus einem Fredy-Update ohne Bridge-Update funktionieren.
const KNOWN_CATEGORIES =
  'supermarket, bakery, pharmacy, doctor, kindergarten, school, gym, swimmingPool, park, restaurant, postOffice, busStop, trainStation';

const TEMPLATE_LANGUAGES = ['de', 'en', 'it'];
const DEAL_TYPES = ['rent', 'buy'];

const listingIdSchema = { type: 'object', properties: { listingId: { type: 'string', minLength: 1 } }, required: ['listingId'], additionalProperties: false };

/** Entfernt Routen-Geometrie (nur für Fredys Karte gedacht) aus beliebig verschachtelten Daten. */
function withoutGeometry(value) {
  if (Array.isArray(value)) return value.map(withoutGeometry);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !/geometry/i.test(k)).map(([k, v]) => [k, withoutGeometry(v)]));
  }
  return value;
}

/** Gespeicherten Ort in das Format zurückverwandeln, das Fredys Speichern erwartet. */
function toCandidate(entry) {
  const candidate = { label: entry.label, mode: entry.mode };
  if (entry.kind === 'category') Object.assign(candidate, { kind: 'category', category: entry.category });
  else candidate.address = entry.address;
  if (entry.departure) candidate.departure = entry.departure;
  return candidate;
}

function describePlaces(entries) {
  return (entries || []).map((e) => ({
    label: e.label,
    ...(e.kind === 'category' ? { category: e.category } : { address: e.address, found: !(e.coords?.lat === -1 && e.coords?.lng === -1) }),
    mode: e.mode || 'transit',
    departureTime: e.departure?.time ?? null,
  }));
}

async function savePlaces(fredy, username, candidates) {
  const res = await fredy.asUser(username, 'POST', '/api/user/settings/home-address', { home_addresses: candidates });
  if (res.status !== 200) return { error: fredyFailure(res.status, res.data, 'Could not save the places.') };
  return { places: describePlaces(res.data?.home_addresses), queued: res.data?.queued ?? 0 };
}

const placesNote = (queued) =>
  queued > 0
    ? `Fredy recalculates travel times for ${queued} listing(s) in the background; this can take a while (Fredy works through a batch every two hours). Use get_travel_times for a single listing right away.`
    : 'Travel times did not need recalculating.';

// Bewerberprofil: Feld → erlaubter Typ (Fredy selbst speichert alles als freien Text/Wert).
const APPLICANT_FIELDS = {
  firstName: { type: 'string', maxLength: 100 },
  lastName: { type: 'string', maxLength: 100 },
  street: { type: 'string', maxLength: 200 },
  zip: { type: 'string', maxLength: 20 },
  city: { type: 'string', maxLength: 100 },
  phone: { type: 'string', maxLength: 50 },
  email: { type: 'string', maxLength: 200 },
  adults: { type: 'integer', minimum: 0, maximum: 20, description: 'Adults moving in.' },
  children: { type: 'integer', minimum: 0, maximum: 20, description: 'Children moving in.' },
  pets: { type: 'string', maxLength: 300, description: 'Free text, e.g. "a cat".' },
  smoker: { type: 'boolean' },
  occupation: { type: 'string', maxLength: 200 },
  employer: { type: 'string', maxLength: 200 },
  employmentType: { type: 'string', enum: ['permanent', 'temporary', 'selfEmployed', 'civilServant', 'student', 'retired'] },
  netIncome: { type: 'number', minimum: 0, description: 'Monthly net household income, EUR.' },
  moveInDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Earliest move-in date, YYYY-MM-DD.' },
  schufa: { type: 'boolean', description: 'A current SCHUFA report is available.' },
  wbs: { type: 'boolean', description: 'Has a Wohnberechtigungsschein.' },
  guarantor: { type: 'boolean', description: 'A guarantor is available.' },
  extra: { type: 'string', maxLength: 4000, description: 'Free paragraph added to the letter (a few sentences about you).' },
};

function validateApplicant(changes) {
  const errors = [];
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length === 0) {
    return ['Pass at least one field to change.'];
  }
  for (const [key, value] of Object.entries(changes)) {
    const rule = APPLICANT_FIELDS[key];
    if (!rule) {
      errors.push(`${key} is not a known field.`);
      continue;
    }
    if (value === null) continue; // null löscht das Feld
    if (rule.type === 'string') {
      if (typeof value !== 'string') errors.push(`${key} must be text.`);
      else if (value.length > rule.maxLength) errors.push(`${key} is longer than ${rule.maxLength} characters.`);
      else if (rule.enum && !rule.enum.includes(value)) errors.push(`${key} must be one of ${rule.enum.join(', ')}.`);
      else if (rule.pattern && !new RegExp(rule.pattern).test(value)) errors.push(`${key} must look like 2026-03-01.`);
    } else if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') errors.push(`${key} must be true or false.`);
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${key} must be a number.`);
    } else if (rule.type === 'integer' && !Number.isInteger(value)) {
      errors.push(`${key} must be a whole number.`);
    } else if (value < rule.minimum || (rule.maximum !== undefined && value > rule.maximum)) {
      errors.push(`${key} is out of range.`);
    }
  }
  return errors;
}

const PLACEHOLDER_HELP =
  'Placeholders: {{listing.title}}, {{listing.address}}, {{listing.price}}, {{listing.size}}, {{listing.rooms}}, {{listing.pricePerSqm}}, ' +
  '{{listing.link}}, {{listing.provider}}, {{listing.publishedAt}}, {{applicant.fullName}}, {{applicant.firstName}}, {{applicant.lastName}}, ' +
  '{{applicant.address}}, {{applicant.street}}, {{applicant.zip}}, {{applicant.city}}, {{applicant.phone}}, {{applicant.email}}, ' +
  '{{applicant.household}}, {{applicant.pets}}, {{applicant.smoker}}, {{applicant.occupation}}, {{applicant.employer}}, ' +
  '{{applicant.employmentType}}, {{applicant.netIncome}}, {{applicant.moveInDate}}, {{applicant.schufa}}, {{applicant.wbs}}, ' +
  '{{applicant.guarantor}}, {{applicant.extra}}, {{contact.name}}, {{contact.company}}, {{contact.salutation}}, {{today}}. ' +
  'Rules: {{key|fallback}} uses the fallback text when the value is empty; a line whose placeholders are ALL empty is dropped ' +
  'completely, so put one fact per line. Unknown placeholders stay visible and are reported by the preview.';

export const PROFILE_TOOLS = [
  // ---- Preisverlauf ----------------------------------------------------------------------------
  {
    name: 'get_price_history',
    permission: 'listings.price_history',
    definition: {
      title: 'Get price history',
      description:
        'Price changes Fredy has observed for one listing, oldest first (price in EUR, observed_at in unix milliseconds). ' +
        'Use it to answer whether a listing got cheaper or more expensive and since when.',
      inputSchema: listingIdSchema,
      annotations: { title: 'Get price history', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      const listingId = requireString(args, 'listingId');
      const res = await fredy.asUser(username, 'GET', `/api/listings/${encodeURIComponent(listingId)}/priceHistory`);
      if (res.status !== 200) return fredyFailure(res.status, res.data, 'Could not read the price history.');
      const history = Array.isArray(res.data) ? res.data : [];
      if (history.length === 0) return text('Fredy has no price changes recorded for this listing (the price has not changed since it was found).');
      const first = history[0].price;
      const last = history[history.length - 1].price;
      return text({
        entries: history,
        summary:
          first != null && last != null
            ? { first, last, change: last - first, changePct: first ? Math.round(((last - first) / first) * 1000) / 10 : null }
            : null,
      });
    },
  },

  // ---- Orte & Fahrzeiten -------------------------------------------------------------------------
  {
    name: 'get_places',
    permission: 'places.read',
    definition: {
      title: 'Get places for travel times',
      description:
        "The user's places that Fredy measures travel times to for every listing: fixed addresses (work, school, parents …) " +
        'and place types (e.g. "nearest school", resolved per listing). Each has a transport mode and optionally a departure time.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Get places for travel times', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username) {
      const { settings, error } = await readUserSettings(fredy, username);
      if (error) return error;
      const places = describePlaces(settings.home_addresses);
      return text(places.length ? { places } : 'No places saved yet. Add one with set_place.');
    },
  },
  {
    name: 'get_travel_times',
    permission: 'places.read',
    definition: {
      title: 'Get exact travel times',
      description:
        "Exact journeys from one listing to each of the user's places, for public transport (with transfers), car, bike and walking – " +
        'the same as opening the listing in Fredy. get_listing already shows a quick estimate; use this when the user wants the real journey. ' +
        `Contacts routing services, so use it for single listings only (limited to ${travelLimiter.perHour} per hour).`,
      inputSchema: listingIdSchema,
      annotations: { title: 'Get exact travel times', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async run(fredy, username, args) {
      const listingId = requireString(args, 'listingId');
      const slot = travelLimiter.acquire(username);
      if (slot.error) return failure(slot.error);
      try {
        const res = await fredy.asUser(username, 'GET', `/api/transit/travel-times?listingId=${encodeURIComponent(listingId)}`);
        if (res.status !== 200) {
          if (res.status === 403 || res.status === 404 || res.status === 400) slot.release();
          return fredyFailure(res.status, res.data, 'Could not get the travel times.');
        }
        const travelTimes = withoutGeometry(res.data?.travelTimes ?? []);
        if (travelTimes.length === 0) {
          slot.release();
          return text('No travel times: either the user has no places saved (see get_places) or the listing has no known location.');
        }
        return text({ travelTimes });
      } finally {
        slot.done();
      }
    },
  },
  {
    name: 'set_place',
    permission: 'places.write',
    definition: {
      title: 'Add or change a place',
      description:
        'Add a place Fredy should measure travel times to, or change an existing one (matched by label, case-insensitive). ' +
        'Give EITHER an address (a fixed place like work, a specific school, parents) OR a category (Fredy finds the nearest one for every listing). ' +
        `Known categories: ${KNOWN_CATEGORIES}. ` +
        'When changing a place, only the fields passed change. Fredy then recalculates travel times in the background.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 60, description: 'Unique name, e.g. "Work", "Grundschule Am Park", "Nearest school".' },
          newLabel: { type: 'string', minLength: 1, maxLength: 60, description: 'Only to rename an existing place.' },
          address: { type: 'string', minLength: 3, maxLength: 300, description: 'Full address incl. city.' },
          category: { type: 'string', description: `Place type instead of an address: ${KNOWN_CATEGORIES}.` },
          mode: { type: 'string', enum: MODES, description: 'How the user travels there (default transit).' },
          departureTime: { type: ['string', 'null'], pattern: '^\\d{1,2}:\\d{2}$', description: 'Departure time HH:MM on a working day, e.g. "07:30". null = Fredy default.' },
        },
        required: ['label'],
        additionalProperties: false,
      },
      annotations: { title: 'Add or change a place', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async run(fredy, username, args) {
      const label = requireString(args, 'label');
      if (args.address && args.category) return failure('Give either an address or a category, not both.');
      if (args.mode !== undefined && !MODES.includes(args.mode)) return failure(`mode must be one of ${MODES.join(', ')}.`);
      if (args.departureTime != null && !/^\d{1,2}:\d{2}$/.test(args.departureTime)) return failure('departureTime must look like 07:30.');

      const { settings, error } = await readUserSettings(fredy, username);
      if (error) return error;
      const candidates = (settings.home_addresses || []).map(toCandidate);
      const index = candidates.findIndex((c) => String(c.label).toLowerCase() === label.toLowerCase());
      const existing = index >= 0 ? candidates[index] : null;
      if (!existing && !args.address && !args.category) return failure('A new place needs an address or a category.');

      // Beim Ändern bleibt der gespeicherte Name (inkl. Schreibweise); umbenannt wird nur mit newLabel.
      const finalLabel = (typeof args.newLabel === 'string' && args.newLabel.trim()) || (existing ? existing.label : label);
      const clash = candidates.some((c, i) => i !== index && String(c.label).toLowerCase() === finalLabel.toLowerCase());
      if (clash) return failure(`There is already a place called "${finalLabel}".`);
      const next = existing ? { ...existing, label: finalLabel } : { label: finalLabel, mode: 'transit' };
      if (args.address) {
        delete next.kind;
        delete next.category;
        next.address = args.address.trim();
      }
      if (args.category) {
        delete next.address;
        Object.assign(next, { kind: 'category', category: args.category.trim() });
      }
      if (args.mode) next.mode = args.mode;
      if (args.departureTime === null) delete next.departure;
      else if (args.departureTime) next.departure = { time: args.departureTime };

      if (existing) candidates[index] = next;
      else candidates.push(next);
      const saved = await savePlaces(fredy, username, candidates);
      if (saved.error) return saved.error;
      const mine = saved.places.find((p) => p.label.toLowerCase() === finalLabel.toLowerCase());
      const warning = mine?.found === false ? ' WARNING: Fredy could not find this address on the map – ask the user for a more precise address.' : '';
      return text({ saved: existing ? 'changed' : 'added', place: mine, places: saved.places, note: placesNote(saved.queued) + warning });
    },
  },
  {
    name: 'remove_place',
    permission: 'places.write',
    definition: {
      title: 'Remove a place',
      description: 'Remove one of the places Fredy measures travel times to (matched by label, case-insensitive).',
      inputSchema: { type: 'object', properties: { label: { type: 'string', minLength: 1 } }, required: ['label'], additionalProperties: false },
      annotations: { title: 'Remove a place', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      const label = requireString(args, 'label');
      const { settings, error } = await readUserSettings(fredy, username);
      if (error) return error;
      const candidates = (settings.home_addresses || []).map(toCandidate);
      const remaining = candidates.filter((c) => String(c.label).toLowerCase() !== label.toLowerCase());
      if (remaining.length === candidates.length) {
        return failure(`No place called "${label}". Existing places: ${candidates.map((c) => c.label).join(', ') || 'none'}.`);
      }
      const saved = await savePlaces(fredy, username, remaining);
      if (saved.error) return saved.error;
      return text({ removed: label, places: saved.places, note: placesNote(saved.queued) });
    },
  },

  // ---- Bewerberprofil & Anschreiben -------------------------------------------------------------
  {
    name: 'get_applicant_profile',
    permission: 'applicant.read',
    definition: {
      title: 'Get applicant profile',
      description:
        "The user's applicant profile that Fredy fills application letters from (get_application_letter), plus which letter templates " +
        'the user has customised (per language and rent/buy). Use preview_application_template to see a template\'s text.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Get applicant profile', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username) {
      const { settings, error } = await readUserSettings(fredy, username);
      if (error) return error;
      const templates = settings.application_templates || {};
      const customised = Object.entries(templates).flatMap(([lang, perDeal]) => Object.keys(perDeal || {}).map((deal) => `${lang}/${deal}`));
      return text({
        profile: settings.applicant_profile ?? null,
        customisedTemplates: customised,
        templateLanguages: TEMPLATE_LANGUAGES,
        knownFields: Object.keys(APPLICANT_FIELDS),
      });
    },
  },
  {
    name: 'preview_application_template',
    permission: 'applicant.read',
    definition: {
      title: 'Preview application template',
      description:
        "Render an application letter template with the user's applicant profile and a sample listing. Without template, shows the " +
        "template currently in use (the user's own or Fredy's default) – use this to read it before changing it. With template, previews a draft " +
        `without saving. ${PLACEHOLDER_HELP}`,
      inputSchema: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: TEMPLATE_LANGUAGES, description: 'Letters are written in the language of the portal.' },
          dealType: { type: 'string', enum: DEAL_TYPES },
          template: { type: 'string', maxLength: 20000, description: 'Draft to preview. Omit to see the template in use.' },
        },
        required: ['language', 'dealType'],
        additionalProperties: false,
      },
      annotations: { title: 'Preview application template', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      if (!TEMPLATE_LANGUAGES.includes(args?.language)) return failure(`language must be one of ${TEMPLATE_LANGUAGES.join(', ')}.`);
      if (!DEAL_TYPES.includes(args?.dealType)) return failure('dealType must be rent or buy.');
      let template = typeof args.template === 'string' ? args.template : null;
      let source = template === null ? 'fredy-default' : 'draft';
      if (template === null) {
        const { settings, error } = await readUserSettings(fredy, username);
        if (error) return error;
        const own = settings.application_templates?.[args.language]?.[args.dealType];
        if (typeof own === 'string') {
          template = own;
          source = 'customised';
        }
      }
      const res = await fredy.asUser(username, 'POST', '/api/user/settings/application-preview', {
        template,
        language: args.language,
        dealType: args.dealType,
      });
      if (res.status !== 200) return fredyFailure(res.status, res.data, 'Could not render the preview.');
      return text({ source, ...res.data });
    },
  },
  {
    name: 'update_applicant_profile',
    permission: 'applicant.write',
    definition: {
      title: 'Update applicant profile',
      description:
        "Change the user's applicant profile used for application letters. Pass ONLY the fields that should change; null clears a field. " +
        'If any field is invalid, nothing is saved and every problem is reported.',
      inputSchema: { type: 'object', properties: APPLICANT_FIELDS, additionalProperties: false },
      annotations: { title: 'Update applicant profile', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      const errors = validateApplicant(args);
      if (errors.length) return failure(`Nothing was saved:\n- ${errors.join('\n- ')}`);
      const { settings, error } = await readUserSettings(fredy, username);
      if (error) return error;
      const profile = { ...(settings.applicant_profile || {}) };
      for (const [key, value] of Object.entries(args)) {
        if (value === null) delete profile[key];
        else profile[key] = typeof value === 'string' ? value.trim() : value;
      }
      const res = await fredy.asUser(username, 'POST', '/api/user/settings/applicant-profile', { applicant_profile: profile });
      if (res.status !== 200) return fredyFailure(res.status, res.data, 'Could not save the applicant profile.');
      return text({ saved: true, changed: Object.keys(args), profile: res.data?.applicant_profile ?? profile });
    },
  },
  {
    name: 'set_application_template',
    permission: 'applicant.write',
    definition: {
      title: 'Set application template',
      description:
        'Save the user\'s own application letter template for one language and deal type, replacing Fredy\'s default for it. ' +
        'Pass template=null to go back to Fredy\'s default. Always preview_application_template a draft first and show it to the user. ' +
        PLACEHOLDER_HELP,
      inputSchema: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: TEMPLATE_LANGUAGES },
          dealType: { type: 'string', enum: DEAL_TYPES },
          template: { type: ['string', 'null'], maxLength: 20000 },
        },
        required: ['language', 'dealType', 'template'],
        additionalProperties: false,
      },
      annotations: { title: 'Set application template', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async run(fredy, username, args) {
      if (!TEMPLATE_LANGUAGES.includes(args?.language)) return failure(`language must be one of ${TEMPLATE_LANGUAGES.join(', ')}.`);
      if (!DEAL_TYPES.includes(args?.dealType)) return failure('dealType must be rent or buy.');
      if (args.template !== null && typeof args.template !== 'string') return failure('template must be text or null.');
      const { settings, error } = await readUserSettings(fredy, username);
      if (error) return error;
      const templates = structuredClone(settings.application_templates || {});
      if (args.template === null || args.template.trim() === '') {
        if (templates[args.language]) delete templates[args.language][args.dealType];
        if (templates[args.language] && Object.keys(templates[args.language]).length === 0) delete templates[args.language];
      } else {
        templates[args.language] = { ...(templates[args.language] || {}), [args.dealType]: args.template };
      }
      const payload = Object.keys(templates).length ? templates : null;
      const res = await fredy.asUser(username, 'POST', '/api/user/settings/application-templates', { application_templates: payload });
      if (res.status !== 200) return fredyFailure(res.status, res.data, 'Could not save the template.');
      return text(
        args.template === null || args.template.trim() === ''
          ? `The ${args.language}/${args.dealType} letter uses Fredy's default template again.`
          : `Saved your ${args.language}/${args.dealType} template. get_application_letter uses it from now on.`,
      );
    },
  },
];
