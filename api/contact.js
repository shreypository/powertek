/**
 * POST /api/contact — Powertek website enquiry endpoint.
 *
 * Vercel serverless function (Node runtime). Accepts a JSON enquiry from the
 * contact form in index.html, validates it server-side, then fans out to two
 * destinations in parallel:
 *
 *   1. Resend        → notification email to CONTACT_TO_EMAIL
 *   2. Google Sheets → one appended row in the enquiry log
 *
 * Every credential comes from an environment variable. Nothing in this file is
 * ever sent to the browser except the small JSON envelope built in `send()`.
 */

import { Resend } from 'resend';
import { JWT } from 'google-auth-library';

/* -------------------------------------------------------------------------
   Configuration
   ------------------------------------------------------------------------- */

// Hard cap on the raw request body. The form cannot legitimately produce
// anything close to this, so anything larger is rejected before parsing.
const MAX_BODY_BYTES = 20_000;

// Per-field maximum lengths, applied after trimming.
const LIMITS = { name: 100, email: 254, phone: 32, message: 5000 };

// Column order of the Google Sheet. The first row of the sheet is the header
// row and is never overwritten — new enquiries are always appended below it.
// NOTE: there is deliberately no "Company" column: the live form collects
// name / email / phone / message only. If a company input is ever added to the
// form, add 'Company' here, bump SHEET_LAST_COL to 'F', add the value to the
// row built in appendToSheet(), and insert the column in the sheet.
const SHEET_COLUMNS = ['Timestamp', 'Name', 'Email', 'Phone', 'Message'];
const SHEET_LAST_COL = 'E'; // must match SHEET_COLUMNS.length

// Best-effort abuse throttle. Per-instance and in-memory, so it is a speed bump
// rather than a guarantee — which is the right trade-off for a public contact
// form on a plain Vercel deployment (no Redis / KV infrastructure required).
const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 5 };

// Upper bound on each outbound call so a hanging provider cannot burn the whole
// function timeout.
const UPSTREAM_TIMEOUT_MS = 7_000;

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// Generic, non-revealing copy. Provider errors never reach the browser.
const GENERIC_FAILURE = "We couldn't submit your enquiry. Please try again, or email powertek.elec@gmail.com directly.";

/* -------------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------------- */

function send(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(status).json(payload);
}

/** Short opaque id shared between the server log and the client response. */
function newRef() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out after ' + UPSTREAM_TIMEOUT_MS + 'ms')), UPSTREAM_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Log an upstream failure without ever touching credentials. Only the provider
 * name, our reference id and the error's own message are recorded — the JWT,
 * the API key and the request body stay out of the log stream.
 */
function logFailure(ref, operation, err) {
  const detail = err && err.message ? String(err.message).slice(0, 500) : 'unknown error';
  console.error('[contact:' + ref + '] ' + operation + ' failed: ' + detail);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd.length) return String(fwd[0]).split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.length) return real;
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* -------------------------------------------------------------------------
   Rate limiting (in-memory, per warm instance)
   ------------------------------------------------------------------------- */

const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();

  // Opportunistic sweep so a long-lived instance cannot grow the map forever.
  if (hits.size > 500) {
    for (const [key, stamps] of hits) {
      if (!stamps.some((t) => now - t < RATE_LIMIT.windowMs)) hits.delete(key);
    }
  }

  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (recent.length >= RATE_LIMIT.max) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

/* -------------------------------------------------------------------------
   Body reading & parsing
   ------------------------------------------------------------------------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Collect the raw request stream, aborting as soon as the cap is exceeded. */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Your enquiry is too large. Please shorten the message.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new HttpError(400, 'We could not read your request.')));
  });
}

/**
 * Vercel's Node runtime usually pre-parses a JSON body onto `req.body`, but
 * that is not guaranteed across runtimes/local tooling — so both shapes are
 * handled, and parsing is always guarded.
 */
async function parseBody(req) {
  let raw = req.body;

  if (raw === undefined || raw === null) raw = await readRawBody(req);

  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');

  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Your enquiry is too large. Please shorten the message.');
    }
    if (!raw.trim()) throw new HttpError(400, 'Your enquiry was empty. Please fill in the form and try again.');
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'We could not read your enquiry. Please try again.');
    }
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, 'We could not read your enquiry. Please try again.');
  }

  return raw;
}

/* -------------------------------------------------------------------------
   Validation & sanitisation
   ------------------------------------------------------------------------- */

/**
 * Normalise a submitted value to a plain single-line-safe string:
 * coerce only real strings, normalise newlines, drop control characters
 * (which is what makes header injection and log poisoning impossible),
 * collapse runaway blank lines, then trim.
 */
function clean(value, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  let out = value.replace(/\r\n?/g, '\n');
  // Strip every C0/C1 control character except tab and newline. This is what
  // makes header injection and log poisoning impossible.
  out = out.replace(/\p{Cc}/gu, (ch) => (ch === '\n' || ch === '\t' ? ch : ''));
  out = multiline ? out.replace(/\n{4,}/g, '\n\n\n') : out.replace(/[\n\t]+/g, ' ');
  return out.replace(/[ \t]{3,}/g, '  ').trim();
}

// Deliberately conservative: no whitespace, no quoting, no comments, no angle
// brackets or commas — i.e. nothing that could be smuggled into a header.
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;

const PHONE_RE = /^[0-9+()\-. ]{6,32}$/;

function validate(body) {
  const errors = {};

  const name = clean(body.name);
  const email = clean(body.email);
  const phone = clean(body.phone);
  const message = clean(body.message, { multiline: true });

  if (!name) errors.name = 'Please enter your name.';
  else if (name.length > LIMITS.name) errors.name = 'Please keep your name under ' + LIMITS.name + ' characters.';

  if (!email) errors.email = 'Please enter your email address.';
  else if (email.length > LIMITS.email) errors.email = 'That email address is too long.';
  else if (!EMAIL_RE.test(email)) errors.email = 'Please enter a valid email address.';

  // Phone is optional — the live form does not mark it required — but if one is
  // supplied it has to look like a phone number.
  if (phone) {
    if (phone.length > LIMITS.phone) errors.phone = 'That phone number is too long.';
    else if (!PHONE_RE.test(phone)) errors.phone = 'Please enter a valid phone number.';
  }

  if (!message) errors.message = 'Please tell us about your project.';
  else if (message.length > LIMITS.message) errors.message = 'Please keep your message under ' + LIMITS.message + ' characters.';

  return { fields: { name, email, phone, message }, errors };
}

/* -------------------------------------------------------------------------
   Email (Resend)
   ------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(date) {
  const timeZone = process.env.CONTACT_TIMEZONE || 'Asia/Kolkata';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date) + ' (' + timeZone + ')';
  } catch {
    // An invalid CONTACT_TIMEZONE must not take the endpoint down.
    return date.toISOString();
  }
}

function buildEmail(fields, stamp) {
  const rows = [
    ['Name', fields.name],
    ['Email', fields.email],
    ['Phone', fields.phone || '—'],
    ['Received', stamp]
  ];

  const rowHtml = rows
    .map(
      ([label, value]) =>
        '<tr>' +
        '<td style="padding:10px 0;width:110px;vertical-align:top;font:500 11px/1.5 Arial,sans-serif;letter-spacing:.12em;color:#8A8279;text-transform:uppercase;">' +
        escapeHtml(label) +
        '</td>' +
        '<td style="padding:10px 0;vertical-align:top;font:400 15px/1.5 Arial,sans-serif;color:#1C1B19;">' +
        escapeHtml(value) +
        '</td>' +
        '</tr>'
    )
    .join('');

  const html =
    '<!doctype html><html><body style="margin:0;padding:0;background:#F6F2ED;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F2ED;padding:32px 16px;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid rgba(20,18,16,.10);border-radius:18px;overflow:hidden;">' +
    '<tr><td style="padding:26px 32px;background:#141414;">' +
    '<div style="font:700 15px/1 Arial,sans-serif;letter-spacing:.22em;color:#FFFFFF;">POWERTEK</div>' +
    '<div style="margin-top:9px;font:400 13px/1 Arial,sans-serif;color:#D74627;">New Website Enquiry</div>' +
    '</td></tr>' +
    '<tr><td style="padding:26px 32px 6px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + rowHtml + '</table>' +
    '</td></tr>' +
    '<tr><td style="padding:14px 32px 28px;">' +
    '<div style="font:500 11px/1.5 Arial,sans-serif;letter-spacing:.12em;color:#8A8279;text-transform:uppercase;">Project details</div>' +
    '<div style="margin-top:10px;padding:16px 18px;border-radius:12px;background:#FDF3EF;border:1px solid rgba(215,70,39,.16);font:400 15px/1.65 Arial,sans-serif;color:#1C1B19;white-space:pre-wrap;">' +
    escapeHtml(fields.message) +
    '</div></td></tr>' +
    '<tr><td style="padding:0 32px 28px;">' +
    '<a href="mailto:' + escapeHtml(fields.email) + '" style="display:inline-block;padding:13px 24px;border-radius:100px;background:#D74627;font:600 13px/1 Arial,sans-serif;color:#FFFFFF;text-decoration:none;">Reply to ' + escapeHtml(fields.name) + '</a>' +
    '</td></tr>' +
    '<tr><td style="padding:16px 32px;background:#FAF7F3;border-top:1px solid rgba(20,18,16,.08);font:400 12px/1.6 Arial,sans-serif;color:#6B645C;">' +
    'Sent automatically from the Powertek website contact form.' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';

  const text =
    'POWERTEK — New Website Enquiry\n\n' +
    'Name:     ' + fields.name + '\n' +
    'Email:    ' + fields.email + '\n' +
    'Phone:    ' + (fields.phone || '—') + '\n' +
    'Received: ' + stamp + '\n\n' +
    'Project details:\n' + fields.message + '\n\n' +
    '—\nSent automatically from the Powertek website contact form.';

  return { html, text };
}

async function sendEmail(fields, stamp) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.CONTACT_FROM_EMAIL;
  const to = process.env.CONTACT_TO_EMAIL;

  if (!apiKey || !from || !to) {
    throw new Error('Resend is not configured (RESEND_API_KEY, CONTACT_FROM_EMAIL or CONTACT_TO_EMAIL missing)');
  }

  const { html, text } = buildEmail(fields, stamp);
  const resend = new Resend(apiKey);

  const { data, error } = await resend.emails.send({
    from,
    to: to.split(',').map((address) => address.trim()).filter(Boolean),
    subject: 'New Website Enquiry — Powertek',
    html,
    text,
    // The visitor's address is only used here, and only after it has passed the
    // strict validation above — so it cannot inject additional headers.
    replyTo: fields.email
  });

  if (error) throw new Error(error.message || 'Resend rejected the message');
  return data;
}

/* -------------------------------------------------------------------------
   Google Sheets
   ------------------------------------------------------------------------- */

let sheetsClient = null;
let headerChecked = false;

/**
 * Vercel stores multi-line secrets with literal "\n" sequences, and pasting a
 * key often leaves wrapping quotes behind. Both are normalised here so the same
 * value works locally, in `vercel dev`, and in the dashboard.
 */
function normalisePrivateKey(raw) {
  let key = String(raw).trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, '\n');
}

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!email || !rawKey || !sheetId) {
    throw new Error('Google Sheets is not configured (GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY missing)');
  }

  sheetsClient = new JWT({ email, key: normalisePrivateKey(rawKey), scopes: [SHEETS_SCOPE] });
  return sheetsClient;
}

/** A1 notation for the configured tab, with quoting for names containing spaces. */
function sheetRange(suffix) {
  const tab = (process.env.GOOGLE_SHEET_TAB || 'Sheet1').replace(/'/g, "''");
  return "'" + tab + "'!" + suffix;
}

function sheetsUrl(path, query) {
  const id = encodeURIComponent(process.env.GOOGLE_SHEET_ID);
  return 'https://sheets.googleapis.com/v4/spreadsheets/' + id + path + (query ? '?' + query : '');
}

/**
 * Write the header row if — and only if — the sheet is completely empty.
 * Runs at most once per warm instance and never overwrites existing data:
 * if row 1 already holds anything, it is left exactly as the owner set it up.
 */
async function ensureHeaderRow(client, ref) {
  if (headerChecked) return;
  headerChecked = true;
  try {
    const range = sheetRange('A1:' + SHEET_LAST_COL + '1');
    const existing = await client.request({
      url: sheetsUrl('/values/' + encodeURIComponent(range)),
      method: 'GET'
    });
    const values = existing.data && existing.data.values;
    if (values && values.length && values[0].some((cell) => String(cell || '').trim())) return;

    await client.request({
      url: sheetsUrl('/values/' + encodeURIComponent(range), 'valueInputOption=RAW'),
      method: 'PUT',
      data: { values: [SHEET_COLUMNS] }
    });
  } catch (err) {
    // Never fail an enquiry because the header could not be written.
    logFailure(ref, 'google-sheets header check', err);
  }
}

async function appendToSheet(fields, stamp, ref) {
  const client = getSheetsClient();
  await ensureHeaderRow(client, ref);

  const row = [stamp, fields.name, fields.email, fields.phone || '', fields.message];

  // valueInputOption=RAW stores every cell as literal text, so a message that
  // starts with "=" or "+" is never evaluated as a spreadsheet formula.
  await client.request({
    url: sheetsUrl(
      '/values/' + encodeURIComponent(sheetRange('A:' + SHEET_LAST_COL)) + ':append',
      'valueInputOption=RAW&insertDataOption=INSERT_ROWS'
    ),
    method: 'POST',
    data: { values: [row] }
  });
}

/* -------------------------------------------------------------------------
   Handler
   ------------------------------------------------------------------------- */

export default async function handler(req, res) {
  const ref = newRef();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { success: false, message: 'Method not allowed.' });
  }

  // Requiring JSON is also the cross-origin guard: a JSON content type forces a
  // CORS preflight, and this endpoint answers no CORS headers at all, so only
  // same-origin pages can post to it from a browser.
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('application/json')) {
    return send(res, 415, { success: false, message: 'Unsupported content type. Please send JSON.' });
  }

  if (rateLimited(clientIp(req))) {
    return send(res, 429, {
      success: false,
      message: 'Too many enquiries from this connection. Please wait a few minutes, or call +91 98452 39932.'
    });
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400;
    return send(res, status, { success: false, message: err.message || 'We could not read your enquiry.' });
  }

  // Honeypot: the form ships a hidden "website" input that a human never sees
  // and never fills. Bots that fill every field get a normal-looking success
  // response and nothing is sent or logged to the sheet.
  if (clean(body.website)) {
    console.warn('[contact:' + ref + '] discarded honeypot submission');
    return send(res, 200, { success: true, message: 'Your enquiry has been submitted successfully.' });
  }

  const { fields, errors } = validate(body);
  if (Object.keys(errors).length) {
    return send(res, 400, {
      success: false,
      message: 'Please check the highlighted fields and try again.',
      errors
    });
  }

  const stamp = formatTimestamp(new Date());

  // Both destinations are attempted regardless of the other's outcome, so a
  // Sheets outage can never suppress the notification email and vice versa.
  const [emailResult, sheetResult] = await Promise.allSettled([
    withTimeout(sendEmail(fields, stamp), 'Resend'),
    withTimeout(appendToSheet(fields, stamp, ref), 'Google Sheets')
  ]);

  const emailOk = emailResult.status === 'fulfilled';
  const sheetOk = sheetResult.status === 'fulfilled';

  if (!emailOk) logFailure(ref, 'resend', emailResult.reason);
  if (!sheetOk) logFailure(ref, 'google-sheets append', sheetResult.reason);

  if (emailOk && sheetOk) {
    return send(res, 200, { success: true, message: 'Your enquiry has been submitted successfully.' });
  }

  if (emailOk && !sheetOk) {
    // The enquiry did reach the team, so telling the visitor it failed would
    // only produce duplicate submissions. The response says exactly what is
    // true — delivered, but not fully recorded — and flags it for monitoring.
    console.error('[contact:' + ref + '] enquiry emailed but NOT logged to the sheet');
    return send(res, 200, {
      success: true,
      partial: true,
      message: 'Your enquiry has been sent to our team. We will respond within one working day.',
      reference: ref
    });
  }

  // The notification did not go out. Even if the row was written, nobody has
  // been alerted, so the visitor is told plainly that it did not go through.
  if (sheetOk) console.error('[contact:' + ref + '] enquiry logged to the sheet but NOT emailed');

  return send(res, 502, { success: false, message: GENERIC_FAILURE, reference: ref });
}
