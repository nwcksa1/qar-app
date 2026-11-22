#!/usr/bin/env node
'use strict';
/**
 * ============================================================================
 *  NWC Quality Assurance Review (QAR) Web Application — Server
 * ----------------------------------------------------------------------------
 *  Zero-dependency Node.js (v18+) server. Built-ins only: http, fs, crypto,
 *  path, os.
 *
 *  Features
 *   - Separate Admin / User portals with strict role isolation
 *   - scrypt password hashing (unique 16-byte salt per user)
 *   - HMAC-SHA256 signed, HTTP-only session cookies (7-day TTL)
 *   - CSRF tokens on every mutating request, Origin checks, CORS preflight
 *   - Login rate limiting (5 attempts / minute / IP -> HTTP 429)
 *   - Atomic JSON flat-file storage with a serialized write queue
 *   - Single-source-of-truth rubric + automated scoring with the mandatory
 *     "controls_performed = Not Done -> 0 %" override (enforced server-side)
 *   - Granular server-side redaction (hidden checks / score / comment and
 *     admin_internal_notes are NEVER sent to employees)
 *   - Change-request -> resolution -> completion -> admin verification workflow
 *   - Threaded feedback, real-time notifications (Server-Sent Events)
 *   - CSV exports (sanitized for employees, full for admins)
 *   - Rolling year filters: always current year + next year + any year with data
 *
 *  Usage
 *    node launch.js                       RECOMMENDED: run tests, then start production
 *    node server.js                       start the server directly (no test gate)
 *    node server.js --reset-admin-password  print a new password for the admin
 *
 *  Environment
 *    PORT (3000) · HOST (0.0.0.0) · DATA_DIR (./data) · SESSION_TTL_SECONDS (604800)
 *    TRUST_PROXY (false) · ADMIN_USERNAME (admin) · ADMIN_PASSWORD (random)
 *    ALLOWED_ORIGINS (comma separated, optional)
 * ============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const defs = require('./lib/definitions');
const { JsonStore } = require('./lib/store');
const sec = require('./lib/security');

/* ========================================================================== *
 *  CONFIGURATION
 * ========================================================================== */
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

const CONFIG = Object.freeze({
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data')),
  sessionTtlSec: parseInt(process.env.SESSION_TTL_SECONDS, 10) || 604800, // 7 days
  // Render / Railway / Heroku-style platforms always sit behind a TLS-terminating proxy.
  trustProxy: truthy(process.env.TRUST_PROXY) || !!process.env.RENDER || !!process.env.DYNO,
  allowedOrigins: String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  loginMaxAttempts: 5,               // failed attempts per IP + username per window
  loginIpMaxFailures: 30,            // failed attempts per IP (any username) per window
  accountMaxFailures: 10,            // failed attempts per username (any IP) per 15 minutes
  accountWindowMs: 15 * 60 * 1000,
  loginWindowMs: 60 * 1000,
  jsonLimit: 1024 * 1024,           // 1 MB for regular JSON bodies
  uploadJsonLimit: 8 * 1024 * 1024, // 8 MB for bodies that carry a base64 attachment
  maxAttachmentBytes: 5 * 1024 * 1024,
  minYear: 2020                     // earliest evaluation year accepted
});

const EVIDENCE_DIR = path.join(CONFIG.dataDir, 'evidence');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

/** HMAC key, generated on first start and persisted with 0600 permissions. */
const SESSION_SECRET = (() => {
  // Prefer a platform secret so sessions survive restarts on ephemeral disks.
  const fromEnv = String(process.env.SESSION_SECRET || '').trim();
  if (fromEnv.length >= 32) return fromEnv;
  if (fromEnv) console.warn('[security] SESSION_SECRET ignored: it must be at least 32 characters.');
  const file = path.join(CONFIG.dataDir, '.session_secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 64) return s;
  } catch (_) { /* first start */ }
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
})();

/* ========================================================================== *
 *  DATA STORES
 * ========================================================================== */
const db = {
  users: new JsonStore(path.join(CONFIG.dataDir, 'users.json'), []),
  reviews: new JsonStore(path.join(CONFIG.dataDir, 'qar_entries.json'), []),
  notifications: new JsonStore(path.join(CONFIG.dataDir, 'notifications.json'), []),
  sessions: new JsonStore(path.join(CONFIG.dataDir, 'sessions.json'), [])
};

const nowIso = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

/* ========================================================================== *
 *  ERRORS & VALIDATION HELPERS
 * ========================================================================== */
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}
const bad = (msg, extra) => new HttpError(400, msg, extra);

/** Optional trimmed string with max length. */
function optStr(v, max, field) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw bad(`${field} must be at most ${max} characters`);
  return s;
}
function reqStr(v, max, field, min = 1) {
  const s = optStr(v, max, field);
  if (s.length < min) throw bad(min > 1 ? `${field} must be at least ${min} characters` : `${field} is required`);
  return s;
}
function optBool(v, field, fallback) {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw bad(`${field} must be true or false`);
  return v;
}
const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const USERNAME_RE = /^[A-Za-z0-9._@-]{3,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates an evaluation period (YYYY-MM).
 * The allowed window rolls forward automatically with the calendar:
 * from CONFIG.minYear up to (current year + 1). No code change is needed
 * when a new year starts.
 */
function parsePeriod(value) {
  const m = PERIOD_RE.exec(typeof value === 'string' ? value.trim() : '');
  if (!m) throw bad('period must be in YYYY-MM format');
  const year = Number(m[1]); const month = Number(m[2]);
  const maxYear = new Date().getFullYear() + 1;
  if (year < CONFIG.minYear || year > maxYear) throw bad(`period year must be between ${CONFIG.minYear} and ${maxYear}`);
  return { period: `${m[1]}-${m[2]}`, year, month };
}

/**
 * Years offered in the Year filters. Always includes the current and the
 * next calendar year plus every year that has reviews, as a continuous,
 * descending range — so 2027, 2028, … appear automatically.
 */
function availableYears(list) {
  const cur = new Date().getFullYear();
  let min = cur - 1; let max = cur + 1;
  for (const r of list) { if (r.year < min) min = r.year; if (r.year > max) max = r.year; }
  const out = [];
  for (let y = max; y >= min; y--) out.push(y);
  return out;
}

/* ========================================================================== *
 *  USERS
 * ========================================================================== */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, fullName: u.fullName, email: u.email || '',
    department: u.department || '', role: u.role, active: u.active !== false,
    mustChangePassword: !!u.mustChangePassword,
    createdAt: u.createdAt, updatedAt: u.updatedAt, lastLoginAt: u.lastLoginAt || null
  };
}
const findUser = (id) => db.users.get().find((u) => u.id === id) || null;
const findUserByName = (name) => {
  const n = String(name || '').toLowerCase();
  return db.users.get().find((u) => u.username.toLowerCase() === n) || null;
};
const emailTaken = (email, exceptId) => {
  const e = String(email || '').toLowerCase();
  return !!e && db.users.get().some((u) => u.id !== exceptId && (u.email || '').toLowerCase() === e);
};
/** Sign-in accepts the username or the account email address. */
const findUserForLogin = (login) => {
  const n = String(login || '').trim().toLowerCase();
  if (!n) return null;
  return findUserByName(n) || db.users.get().find((u) => u.email && u.email.toLowerCase() === n) || null;
};
const activeAdmins = () => db.users.get().filter((u) => u.role === 'admin' && u.active !== false);

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw bad('Password must be at least 8 characters');
  if (pw.length > 128) throw bad('Password must be at most 128 characters');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw bad('Password must contain letters and numbers');
  return pw;
}

function generatePassword() {
  // 16 chars, guaranteed letters + digits, no ambiguous characters.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
  return out.slice(0, 14) + 'a7';
}

/**
 * Ensures the bootstrap administrator exists.
 *  - First start: creates ADMIN_USERNAME (default "admin") with ADMIN_PASSWORD,
 *    or a random password printed once to the console / platform log.
 *  - Every start: if ADMIN_PASSWORD is set, the named admin account is
 *    re-activated and its password re-synchronised with the environment value.
 *    This makes the hosting dashboard the single recovery path for a lost
 *    admin password (Render: Environment -> ADMIN_PASSWORD -> redeploy).
 */
async function seedAdmin() {
  const username = String(process.env.ADMIN_USERNAME || 'admin').trim();
  const envPassword = process.env.ADMIN_PASSWORD ? String(process.env.ADMIN_PASSWORD) : '';
  const envEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (envPassword) {
    try { validatePassword(envPassword); } catch (e) {
      console.error(`[security] ADMIN_PASSWORD rejected: ${e.message}. Use 8+ characters with letters and numbers.`);
      throw new Error('Invalid ADMIN_PASSWORD');
    }
  }
  if (!USERNAME_RE.test(username)) throw new Error('ADMIN_USERNAME must be 3-40 characters: letters, numbers, . _ @ -');
  if (envEmail && !EMAIL_RE.test(envEmail)) throw new Error('ADMIN_EMAIL is not a valid email address');

  const existing = findUserByName(username);
  if (existing && existing.role === 'admin') {
    const patch = {};
    if (envPassword && !sec.verifyPassword(envPassword, existing.salt, existing.passwordHash)) {
      const { salt, hash } = sec.hashPassword(envPassword);
      Object.assign(patch, { salt, passwordHash: hash, mustChangePassword: false });
    }
    if (envPassword && existing.active === false) patch.active = true;
    if (envEmail && existing.email !== envEmail && !db.users.get().some((u) => u.id !== existing.id && (u.email || '').toLowerCase() === envEmail)) patch.email = envEmail;
    if (Object.keys(patch).length) {
      await db.users.update(() => Object.assign(existing, patch, { updatedAt: nowIso() }));
      if (patch.passwordHash) await revokeSessions(existing.id);
      console.log(`[setup] Administrator "${username}" synchronised with environment settings.`);
    }
    return;
  }
  if (existing) { console.warn(`[setup] ADMIN_USERNAME "${username}" belongs to a non-admin account; not modified.`); }
  if (db.users.get().some((u) => u.role === 'admin') && !envPassword) return;
  if (existing) return;

  const password = envPassword || generatePassword();
  const { salt, hash } = sec.hashPassword(password);
  const t = nowIso();
  await db.users.update((users) => users.push({
    id: newId('usr'), username, fullName: 'QAR Administrator', email: envEmail, department: 'Internal Audit',
    role: 'admin', active: true, salt, passwordHash: hash, mustChangePassword: !envPassword,
    createdAt: t, updatedAt: t, lastLoginAt: null
  }));
  console.log('\n  +-----------------------------------------------------------+');
  console.log('  |  Initial administrator account created                    |');
  console.log(`  |  Username : ${username.padEnd(46)}|`);
  console.log(`  |  Password : ${(envPassword ? '(from ADMIN_PASSWORD env)' : password).padEnd(46)}|`);
  console.log('  |  Sign in at /admin/login.html and change it immediately.  |');
  console.log('  +-----------------------------------------------------------+\n');
}

/* ========================================================================== *
 *  COOKIES & SESSIONS
 * ========================================================================== */
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k || k in out) return;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* ignore malformed */ }
  });
  return out;
}

function isSecureRequest(req) {
  if (req.socket && req.socket.encrypted) return true;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function cookieString(name, value, { maxAge, httpOnly, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (maxAge === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : [cookie]);
}

function setAuthCookies(req, res, sessionId, csrfToken) {
  const secure = isSecureRequest(req);
  appendCookie(res, cookieString('session', sec.signValue(sessionId, SESSION_SECRET), { maxAge: CONFIG.sessionTtlSec, httpOnly: true, secure }));
  appendCookie(res, cookieString('csrf_token', csrfToken, { maxAge: CONFIG.sessionTtlSec, httpOnly: false, secure }));
}

function clearAuthCookies(req, res) {
  const secure = isSecureRequest(req);
  appendCookie(res, cookieString('session', '', { maxAge: 0, httpOnly: true, secure }));
  appendCookie(res, cookieString('csrf_token', '', { maxAge: 0, httpOnly: false, secure }));
}

/** Creates a session. Only the SHA-256 of the session id is persisted. */
async function createSession(user, req) {
  const sessionId = sec.randomToken(32);
  const csrfToken = sec.randomToken(32);
  const t = Date.now();
  await db.sessions.update((list) => {
    for (let i = list.length - 1; i >= 0; i--) if (Date.parse(list[i].expiresAt) <= t) list.splice(i, 1);
    list.push({
      idHash: sec.sha256(sessionId), userId: user.id, csrfToken,
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + CONFIG.sessionTtlSec * 1000).toISOString(),
      ip: clientIp(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 200)
    });
  });
  return { sessionId, csrfToken };
}

/** Resolves the authenticated session + user from the signed cookie. */
function getAuth(cookies) {
  const id = sec.unsignValue(cookies.session, SESSION_SECRET);
  if (!id) return null;
  const idHash = sec.sha256(id);
  const session = db.sessions.get().find((s) => s.idHash === idHash);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
  const user = findUser(session.userId);
  if (!user || user.active === false) return null;
  return { session, user };
}

function revokeSessions(userId, exceptIdHash) {
  return db.sessions.update((list) => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].userId === userId && list[i].idHash !== exceptIdHash) list.splice(i, 1);
    }
  });
}

function clientIp(req) {
  if (CONFIG.trustProxy && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ========================================================================== *
 *  ORIGIN / CORS
 * ========================================================================== */
function requestHost(req) {
  return String((CONFIG.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || '').toLowerCase();
}
function isOriginAllowed(req, origin) {
  if (!origin) return true;
  if (CONFIG.allowedOrigins.includes(origin)) return true;
  try { return new URL(origin).host.toLowerCase() === requestHost(req); } catch (_) { return false; }
}
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(req, origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Vary', 'Origin');
}

/* ========================================================================== *
 *  RESPONSE HELPERS
 * ========================================================================== */
function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function sendCsv(res, filename, csv) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store'
  });
  res.end('\uFEFF' + csv); // BOM so Excel opens UTF-8 (Arabic names) correctly
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > limit) { aborted = true; reject(new HttpError(413, 'Request body too large')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) return reject(new HttpError(415, 'Content-Type must be application/json'));
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch (_) { reject(bad('Malformed JSON body')); }
    });
    req.on('error', reject);
  });
}

/* ========================================================================== *
 *  NOTIFICATIONS (persisted + pushed live over Server-Sent Events)
 * ========================================================================== */
const sseClients = new Map(); // userId -> Set<res>

function pushLive(userId, payload) {
  const set = sseClients.get(userId);
  if (!set) return;
  const msg = `event: notification\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) { try { res.write(msg); } catch (_) { /* closed */ } }
}

function notify(recipientIds, { type, title, message, reviewId }) {
  const ids = [...new Set(recipientIds)].filter(Boolean);
  if (!ids.length) return Promise.resolve();
  const created = ids.map((rid) => ({
    id: newId('ntf'), recipientId: rid, type, title, message: String(message).slice(0, 500),
    reviewId: reviewId || null, read: false, createdAt: nowIso()
  }));
  const p = db.notifications.update((list) => {
    list.push(...created);
    if (list.length > 10000) list.splice(0, list.length - 10000);
  });
  created.forEach((n) => pushLive(n.recipientId, n));
  return p;
}
const notifyAdmins = (payload) => notify(activeAdmins().map((a) => a.id), payload);

/* ========================================================================== *
 *  REVIEWS — validation, scoring, redaction
 * ========================================================================== */
function defaultVisibility() {
  const checks = {};
  defs.CHECK_KEYS.forEach((k) => { checks[k] = true; });
  return { checks, overall_quality_score: true, overall_comment: true };
}

/** Merges strictly-boolean visibility input into existing flags. */
function mergeVisibility(input, existing) {
  const base = existing ? JSON.parse(JSON.stringify(existing)) : defaultVisibility();
  if (input === undefined) return base;
  if (!input || typeof input !== 'object') throw bad('visibility must be an object');
  if (input.checks !== undefined) {
    if (!input.checks || typeof input.checks !== 'object') throw bad('visibility.checks must be an object');
    for (const k of Object.keys(input.checks)) {
      if (!defs.CHECK_KEYS.includes(k)) throw bad(`Unknown visibility check: ${k}`);
      base.checks[k] = optBool(input.checks[k], `visibility.checks.${k}`);
    }
  }
  base.overall_quality_score = optBool(input.overall_quality_score, 'visibility.overall_quality_score', base.overall_quality_score);
  base.overall_comment = optBool(input.overall_comment, 'visibility.overall_comment', base.overall_comment);
  return base;
}

/** Validates check statuses. On create all five are required. */
function mergeChecks(input, existing, requireAll) {
  const out = existing ? { ...existing } : {};
  if (input === undefined) {
    if (requireAll) throw bad('checks are required');
    return out;
  }
  if (!input || typeof input !== 'object') throw bad('checks must be an object');
  for (const [k, v] of Object.entries(input)) {
    if (!defs.CHECK_KEYS.includes(k)) throw bad(`Unknown check: ${k}`);
    if (!Object.prototype.hasOwnProperty.call(defs.POINTS, v)) throw bad(`Invalid status for ${k}. Use done, partial or not_done`);
    out[k] = v;
  }
  if (requireAll) for (const k of defs.CHECK_KEYS) if (!out[k]) throw bad(`Missing status for check: ${k}`);
  return out;
}

function mergeCheckRemarks(input, existing) {
  const out = existing ? { ...existing } : {};
  if (input === undefined) return out;
  if (!input || typeof input !== 'object') throw bad('check_remarks must be an object');
  for (const [k, v] of Object.entries(input)) {
    if (!defs.CHECK_KEYS.includes(k)) throw bad(`Unknown check: ${k}`);
    const s = optStr(v, 1000, `check_remarks.${k}`);
    if (s) out[k] = s; else delete out[k];
  }
  return out;
}

/** Applies the scoring rule server-side (incl. mandatory zero override). */
function applyScore(review) {
  const s = defs.computeScore(review.checks);
  review.base_score = s.base;
  review.overall_quality_score = s.score;
  review.score_override_applied = s.overrideApplied;
  review.rating = s.rating;
  return review;
}

function nameOf(userId) { const u = findUser(userId); return u ? u.fullName : 'Former user'; }

/**
 * Employee-facing projection. WHITELIST approach: only explicitly allowed,
 * visible fields are copied. admin_internal_notes is never copied.
 */
function redactForUser(r) {
  const vis = r.visibility || {};
  const out = {
    id: r.id, period: r.period, year: r.year, month: r.month,
    controlId: r.controlId, controlName: r.controlName,
    issuedBy: r.createdByName || 'QA Reviewer',
    status: r.status, changeStatus: r.changeStatus,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
    checks: {}, check_remarks: {}
  };
  for (const k of defs.CHECK_KEYS) {
    if (vis.checks && vis.checks[k] === true) {
      out.checks[k] = r.checks[k];
      if (r.check_remarks && r.check_remarks[k]) out.check_remarks[k] = r.check_remarks[k];
    }
  }
  if (vis.overall_quality_score === true) {
    out.overall_quality_score = r.overall_quality_score;
    out.rating = r.rating;
    if (vis.checks && vis.checks.controls_performed === true) out.score_override_applied = !!r.score_override_applied;
  }
  if (vis.overall_comment === true && r.overall_comment) out.overall_comment = r.overall_comment;

  const att = (r.attachments || []).map((a) => ({ id: a.id, name: a.name, size: a.size, context: a.context, uploadedAt: a.uploadedAt }));
  const cleanResp = (x) => x && ({ type: x.type, remarks: x.remarks, evidence: x.evidence || '', attachmentId: x.attachmentId || null, submittedAt: x.submittedAt });
  out.userResponse = cleanResp(r.userResponse) || null;
  out.responseHistory = (r.responseHistory || []).map(cleanResp);
  out.adminResolution = r.adminResolution ? {
    note: r.adminResolution.note, decision: r.adminResolution.decision,
    resolvedAt: r.adminResolution.resolvedAt, resolvedBy: r.adminResolution.resolvedByName
  } : null;
  out.changeCompletion = r.changeCompletion ? {
    remarks: r.changeCompletion.remarks, evidence: r.changeCompletion.evidence || '',
    attachmentId: r.changeCompletion.attachmentId || null, completedAt: r.changeCompletion.completedAt
  } : null;
  out.changesVerifiedAt = r.changesVerifiedAt || null;
  out.changesVerifiedBy = r.changesVerifiedBy || null;
  out.verificationNote = r.verificationNote || '';
  out.feedbackThread = (r.feedbackThread || []).map((m) => ({ id: m.id, authorName: m.authorName, authorRole: m.authorRole, message: m.message, createdAt: m.createdAt }));
  out.attachments = att;
  return out;
}

/** Admin projection: full record + current employee info. */
function adminView(r) {
  const u = findUser(r.userId);
  return {
    ...r,
    employee: u ? { id: u.id, fullName: u.fullName, username: u.username, department: u.department || '' }
      : { id: r.userId, fullName: r.employeeName || 'Former user', username: '', department: '' }
  };
}

/** year=YYYY&month=MM (plus admin-only filters). */
function filterReviews(list, q, adminFilters) {
  let year = q.get('year'); let month = q.get('month');
  if (year) {
    if (!/^\d{4}$/.test(year)) throw bad('year must be YYYY');
    year = Number(year);
    list = list.filter((r) => r.year === year);
  }
  if (month) {
    if (!/^(0?[1-9]|1[0-2])$/.test(month)) throw bad('month must be MM (01-12)');
    month = Number(month);
    list = list.filter((r) => r.month === month);
  }
  if (adminFilters) {
    const userId = q.get('userId'); const controlId = q.get('controlId');
    const status = q.get('status'); const changeStatus = q.get('changeStatus');
    const search = (q.get('q') || '').toLowerCase().trim();
    if (userId) list = list.filter((r) => r.userId === userId);
    if (controlId) list = list.filter((r) => r.controlId === controlId);
    if (status) list = list.filter((r) => r.status === status);
    if (changeStatus) list = list.filter((r) => r.changeStatus === changeStatus);
    if (search) {
      list = list.filter((r) => [r.controlId, r.controlName, r.employeeName, nameOf(r.userId), r.period]
        .join(' ').toLowerCase().includes(search));
    }
  }
  return [...list].sort((a, b) => (b.period.localeCompare(a.period)) || b.createdAt.localeCompare(a.createdAt));
}

function getReviewOr404(id) {
  const r = db.reviews.get().find((x) => x.id === id);
  if (!r) throw new HttpError(404, 'Review not found');
  return r;
}

/* ========================================================================== *
 *  EVIDENCE ATTACHMENTS (optional, base64 in JSON, stored under data/evidence)
 * ========================================================================== */
const ALLOWED_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'txt', 'csv', 'xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx', 'zip', 'msg', 'eml']);

function prepareAttachment(file, uploader, context) {
  if (file === undefined || file === null) return null;
  if (typeof file !== 'object') throw bad('attachment must be an object');
  const name = reqStr(file.name, 200, 'attachment.name').replace(/[\\/\r\n"]/g, '_');
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw bad(`File type .${ext} is not allowed`);
  if (typeof file.data !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(file.data)) throw bad('attachment.data must be base64');
  const buf = Buffer.from(file.data, 'base64');
  if (!buf.length) throw bad('Attachment is empty');
  if (buf.length > CONFIG.maxAttachmentBytes) throw bad('Attachment exceeds 5 MB');
  const id = newId('att');
  return {
    buffer: buf,
    meta: { id, name, size: buf.length, context, uploadedBy: uploader.id, uploadedByName: uploader.fullName, uploadedAt: nowIso() }
  };
}
async function persistAttachment(prepared) {
  if (!prepared) return null;
  await fs.promises.writeFile(path.join(EVIDENCE_DIR, prepared.meta.id), prepared.buffer, { mode: 0o600 });
  return prepared.meta;
}

/* ========================================================================== *
 *  CSV EXPORT
 * ========================================================================== */
function csvCell(v) {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula-injection guard
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cells) => cells.map(csvCell).join(',');
const statusLabel = (k) => (defs.STATUSES.find((s) => s.key === k) || {}).label || '';

function buildAdminCsv(list) {
  const header = ['Review ID', 'Period', 'Employee', 'Username', 'Department', 'Control ID', 'Control',
    ...defs.CHECKS.map((c) => c.label), 'Base Score %', 'Overall Quality Score %', 'Zero-Score Override', 'Rating',
    'Overall Comment', 'Admin Internal Notes', 'Review Status', 'Change Status', 'User Response', 'User Remarks',
    'Admin Resolution', 'Changes Completed At', 'Changes Verified At', 'Changes Verified By', 'Thread Messages',
    'Created By', 'Created At', 'Updated At'];
  const rows = list.map((r) => {
    const v = adminView(r);
    return csvRow([r.id, r.period, v.employee.fullName, v.employee.username, v.employee.department, r.controlId, r.controlName,
      ...defs.CHECK_KEYS.map((k) => statusLabel(r.checks[k])), r.base_score, r.overall_quality_score,
      r.score_override_applied ? 'Yes' : 'No', r.rating, r.overall_comment, r.admin_internal_notes, r.status, r.changeStatus,
      r.userResponse ? r.userResponse.type : '', r.userResponse ? r.userResponse.remarks : '',
      r.adminResolution ? r.adminResolution.note : '', r.changeCompletion ? r.changeCompletion.completedAt : '',
      r.changesVerifiedAt || '', r.changesVerifiedBy || '', (r.feedbackThread || []).length,
      r.createdByName, r.createdAt, r.updatedAt]);
  });
  return [csvRow(header), ...rows].join('\r\n');
}

function buildUserCsv(list) {
  const HIDDEN = 'Not shared';
  const header = ['Review ID', 'Period', 'Control ID', 'Control', ...defs.CHECKS.map((c) => c.label),
    'Overall Quality Score %', 'Rating', 'Reviewer Comment', 'Review Status', 'Change Status', 'My Response', 'Admin Resolution',
    'Changes Verified At', 'Issued At'];
  const rows = list.map((r) => {
    const v = redactForUser(r);
    return csvRow([v.id, v.period, v.controlId, v.controlName,
      ...defs.CHECK_KEYS.map((k) => (k in v.checks ? statusLabel(v.checks[k]) : HIDDEN)),
      'overall_quality_score' in v ? v.overall_quality_score : HIDDEN, v.rating || '',
      'overall_comment' in v ? v.overall_comment : '', v.status, v.changeStatus,
      v.userResponse ? v.userResponse.type : '', v.adminResolution ? v.adminResolution.note : '',
      v.changesVerifiedAt || '', v.createdAt]);
  });
  return [csvRow(header), ...rows].join('\r\n');
}

function exportName(prefix, q) {
  const y = /^\d{4}$/.test(q.get('year') || '') ? q.get('year') : 'all';
  const m = /^\d{1,2}$/.test(q.get('month') || '') ? String(q.get('month')).padStart(2, '0') : 'all';
  return `${prefix}_${y}-${m}.csv`;
}

/* ========================================================================== *
 *  ROUTER
 * ========================================================================== */
const routes = [];
/**
 * @param {string} method
 * @param {string} pattern   e.g. '/api/admin/reviews/:id'
 * @param {{auth:'public'|'any'|'admin'|'user', csrf?:boolean, bodyLimit?:number}} opts
 * @param {Function} handler async (ctx) => void
 */
function route(method, pattern, opts, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9_-]+)'; }) + '$');
  routes.push({ method, re, keys, opts, handler });
}

// Only FAILED sign-ins are counted, so a whole office behind one NAT address can sign in freely.
const loginFailLimiter = new sec.RateLimiter(CONFIG.loginMaxAttempts, CONFIG.loginWindowMs);   // ip|username
const ipFailLimiter = new sec.RateLimiter(CONFIG.loginIpMaxFailures, CONFIG.loginWindowMs);     // ip
const accountFailLimiter = new sec.RateLimiter(CONFIG.accountMaxFailures, CONFIG.accountWindowMs); // username
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function handleApi(req, res, url) {
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  let match = null; let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method === req.method) { match = { r, m }; break; }
  }
  if (!match) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');

  const { r, m } = match;
  const params = {}; r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
  const cookies = parseCookies(req.headers.cookie);
  const auth = getAuth(cookies);
  const ctx = { req, res, url, query: url.searchParams, params, cookies, auth, user: auth && auth.user, session: auth && auth.session, body: {} };

  // Authentication & portal role isolation
  if (r.opts.auth !== 'public') {
    if (!auth) throw new HttpError(401, 'Authentication required');
    if (r.opts.auth === 'admin' && auth.user.role !== 'admin') throw new HttpError(403, 'Administrator access required');
    if (r.opts.auth === 'user' && auth.user.role !== 'user') throw new HttpError(403, 'This endpoint is reserved for the User Portal');
  }

  if (MUTATING.has(req.method)) {
    // Cross-site request guard (defence in depth on top of SameSite + CSRF token)
    if (!isOriginAllowed(req, req.headers.origin)) throw new HttpError(403, 'Cross-origin request rejected');
    // CSRF: header must match the token bound to the authenticated session
    if (r.opts.csrf !== false) {
      const token = req.headers['x-csrf-token'];
      if (!auth || !sec.safeEqual(String(token || ''), auth.session.csrfToken)) {
        throw new HttpError(403, 'Invalid or missing CSRF token', { error: 'csrf' });
      }
    }
    ctx.body = await readBody(req, r.opts.bodyLimit || CONFIG.jsonLimit);
  }
  await r.handler(ctx);
}

/* ========================================================================== *
 *  ROUTES — AUTHENTICATION & CORE
 * ========================================================================== */
route('GET', '/api/health', { auth: 'public' }, ({ res }) => sendJson(res, 200, { status: 'ok', version: defs.VERSION, time: nowIso(), uptime: Math.round(process.uptime()) }));

route('GET', '/api/definitions', { auth: 'public' }, ({ res }) => sendJson(res, 200, defs.publicDefinitions()));

route('GET', '/api/csrf-token', { auth: 'public' }, ({ req, res, auth }) => {
  if (auth) {
    appendCookie(res, cookieString('csrf_token', auth.session.csrfToken, { maxAge: CONFIG.sessionTtlSec, httpOnly: false, secure: isSecureRequest(req) }));
    return sendJson(res, 200, { csrfToken: auth.session.csrfToken, authenticated: true });
  }
  // Anonymous token (informational). Login is CSRF-exempt so fresh devices can sign in.
  const t = sec.randomToken(32);
  appendCookie(res, cookieString('csrf_token', t, { maxAge: 3600, httpOnly: false, secure: isSecureRequest(req) }));
  return sendJson(res, 200, { csrfToken: t, authenticated: false });
});

/**
 * POST /api/login  { username, password, portal: 'admin' | 'user' }
 * CSRF-exempt by design (no session exists yet); protected by Origin check,
 * SameSite cookies and rate limiting.
 */
route('POST', '/api/login', { auth: 'public', csrf: false }, async ({ req, res, body }) => {
  const ip = clientIp(req);
  const username = optStr(body.username, 200, 'username');
  const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
  const portal = body.portal === 'admin' ? 'admin' : 'user';
  if (!username || !password) throw bad('Username and password are required');
  const acctKey = username.toLowerCase();
  const pairKey = `${ip}|${acctKey}`;
  const wait = Math.max(loginFailLimiter.blocked(pairKey), ipFailLimiter.blocked(ip), accountFailLimiter.blocked(acctKey));
  if (wait) {
    console.warn(`[security] login throttled ip=${ip} user=${JSON.stringify(acctKey).slice(0, 60)}`);
    return sendJson(res, 429, { error: 'rate_limited', message: `Too many failed sign-in attempts. Try again in ${wait} seconds.` }, { 'Retry-After': String(wait) });
  }
  const fail = () => {
    loginFailLimiter.hit(pairKey); ipFailLimiter.hit(ip); accountFailLimiter.hit(acctKey);
    console.warn(`[security] failed login ip=${ip} user=${JSON.stringify(acctKey).slice(0, 60)} portal=${portal}`);
    return new HttpError(401, 'Invalid username or password');
  };

  const user = findUserForLogin(username);
  if (!user) { sec.burnPasswordCheck(password); throw fail(); }
  if (!sec.verifyPassword(password, user.salt, user.passwordHash)) throw fail();
  loginFailLimiter.reset(pairKey);
  if (user.active === false) throw new HttpError(403, 'This account is disabled. Please contact your administrator.');

  if (user.role !== portal) {
    const toUser = user.role === 'user';
    return sendJson(res, 403, {
      error: 'role_mismatch',
      message: toUser
        ? 'This is an employee account. Please sign in through the User Portal.'
        : 'This is an administrator account. Please sign in through the Admin Portal.',
      redirect: toUser ? '/login.html' : '/admin/login.html',
      linkText: toUser ? 'Go to User Portal' : 'Go to Admin Portal'
    });
  }

  const { sessionId, csrfToken } = await createSession(user, req);
  await db.users.update(() => { user.lastLoginAt = nowIso(); });
  setAuthCookies(req, res, sessionId, csrfToken);
  sendJson(res, 200, {
    user: publicUser(user), csrfToken,
    redirect: user.role === 'admin' ? '/admin/dashboard.html' : '/dashboard.html'
  });
});

route('POST', '/api/logout', { auth: 'public', csrf: false }, async ({ req, res, auth }) => {
  if (auth) {
    if (!sec.safeEqual(String(req.headers['x-csrf-token'] || ''), auth.session.csrfToken)) {
      throw new HttpError(403, 'Invalid or missing CSRF token', { error: 'csrf' });
    }
    const idHash = auth.session.idHash;
    await db.sessions.update((list) => { const i = list.findIndex((s) => s.idHash === idHash); if (i >= 0) list.splice(i, 1); });
  }
  clearAuthCookies(req, res);
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/me', { auth: 'any' }, ({ res, user }) => sendJson(res, 200, { user: publicUser(user) }));

route('POST', '/api/me/password', { auth: 'any' }, async ({ res, user, session, body }) => {
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  if (!sec.verifyPassword(current, user.salt, user.passwordHash)) throw bad('Current password is incorrect');
  const next = validatePassword(body.newPassword);
  if (next === current) throw bad('New password must be different');
  const { salt, hash } = sec.hashPassword(next);
  await db.users.update(() => { user.salt = salt; user.passwordHash = hash; user.mustChangePassword = false; user.updatedAt = nowIso(); });
  await revokeSessions(user.id, session.idHash);
  sendJson(res, 200, { ok: true });
});

/* Live notification stream (Server-Sent Events) */
route('GET', '/api/notifications/stream', { auth: 'any' }, ({ req, res, user }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 5000\n\n');
  if (!sseClients.has(user.id)) sseClients.set(user.id, new Set());
  sseClients.get(user.id).add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { /* closed */ } }, 25000);
  req.on('close', () => {
    clearInterval(hb);
    const set = sseClients.get(user.id);
    if (set) { set.delete(res); if (!set.size) sseClients.delete(user.id); }
  });
});

/* Evidence download — owner or admin only */
route('GET', '/api/evidence/:reviewId/:attId', { auth: 'any' }, async ({ res, params, user }) => {
  const r = getReviewOr404(params.reviewId);
  if (user.role !== 'admin' && r.userId !== user.id) throw new HttpError(404, 'Review not found');
  const a = (r.attachments || []).find((x) => x.id === params.attId);
  if (!a) throw new HttpError(404, 'Attachment not found');
  const file = path.join(EVIDENCE_DIR, a.id);
  let data;
  try { data = await fs.promises.readFile(file); } catch (_) { throw new HttpError(404, 'Attachment file missing'); }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${a.name.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    'Content-Length': data.length, 'Cache-Control': 'no-store'
  });
  res.end(data);
});

/* Threaded feedback — both roles (users only on their own reviews) */
route('POST', '/api/reviews/:id/reply', { auth: 'any' }, async ({ res, params, user, body }) => {
  const r = getReviewOr404(params.id);
  if (user.role !== 'admin' && r.userId !== user.id) throw new HttpError(404, 'Review not found');
  const message = reqStr(body.message, 4000, 'message');
  const entry = { id: newId('msg'), authorId: user.id, authorName: user.fullName, authorRole: user.role, message, createdAt: nowIso() };
  await db.reviews.update(() => { (r.feedbackThread = r.feedbackThread || []).push(entry); r.updatedAt = entry.createdAt; });
  const label = `${r.controlId} (${r.period})`;
  if (user.role === 'admin') {
    await notify([r.userId], { type: 'thread_reply', title: 'New reviewer message', message: `${user.fullName} replied on ${label}.`, reviewId: r.id });
    await notify(activeAdmins().filter((a) => a.id !== user.id).map((a) => a.id), { type: 'thread_reply', title: 'Reviewer message posted', message: `${user.fullName} replied to ${nameOf(r.userId)} on ${label}.`, reviewId: r.id });
  } else {
    await notifyAdmins({ type: 'thread_reply', title: 'Employee replied', message: `${user.fullName} replied on ${label}.`, reviewId: r.id });
  }
  sendJson(res, 201, {
    message: { id: entry.id, authorName: entry.authorName, authorRole: entry.authorRole, message: entry.message, createdAt: entry.createdAt },
    review: user.role === 'admin' ? adminView(r) : redactForUser(r)
  });
});

/* ========================================================================== *
 *  ROUTES — USER PORTAL
 * ========================================================================== */

/** GET /api/me/reviews?year&month  (admins: ?preview=true&userId=… to simulate) */
route('GET', '/api/me/reviews', { auth: 'any' }, ({ res, user, query }) => {
  let targetId = user.id;
  const preview = query.get('preview') === 'true';
  if (user.role === 'admin') {
    if (!preview) throw new HttpError(403, 'This endpoint is reserved for the User Portal. Use ?preview=true&userId=… to preview.');
    const target = findUser(query.get('userId') || '');
    if (!target || target.role !== 'user') throw bad('A valid employee userId is required for preview');
    targetId = target.id;
  }
  const own = db.reviews.get().filter((r) => r.userId === targetId);
  const list = filterReviews(own, query, false);
  sendJson(res, 200, { reviews: list.map(redactForUser), preview: user.role === 'admin', count: list.length, availableYears: availableYears(own) });
});

route('GET', '/api/me/reviews/export', { auth: 'any' }, ({ res, user, query }) => {
  let targetId = user.id;
  if (user.role === 'admin') {
    if (query.get('preview') !== 'true') throw new HttpError(403, 'This endpoint is reserved for the User Portal');
    const target = findUser(query.get('userId') || '');
    if (!target || target.role !== 'user') throw bad('A valid employee userId is required for preview');
    targetId = target.id;
  }
  const list = filterReviews(db.reviews.get().filter((r) => r.userId === targetId), query, false);
  sendCsv(res, exportName('my_qar_reviews', query), buildUserCsv(list));
});

route('POST', '/api/me/reviews/:id/response', { auth: 'user', bodyLimit: CONFIG.uploadJsonLimit }, async ({ res, params, user, body }) => {
  const r = getReviewOr404(params.id);
  if (r.userId !== user.id) throw new HttpError(404, 'Review not found');
  const type = body.type;
  if (!defs.RESPONSE_TYPES.some((t) => t.key === type)) throw bad('type must be accepted, clarification_requested or change_requested');
  if (r.status === 'pending_admin_review') throw new HttpError(409, 'Your previous response is still awaiting admin review');
  if (['awaiting_changes', 'changes_completed'].includes(r.changeStatus)) throw new HttpError(409, 'An approved change is in progress for this review');
  const remarks = type === 'accepted' ? optStr(body.remarks, 4000, 'remarks') : reqStr(body.remarks, 4000, 'remarks', 3);
  const evidence = optStr(body.evidence, 1000, 'evidence');
  const prepared = prepareAttachment(body.attachment, user, 'response');
  const meta = await persistAttachment(prepared);

  const resp = { type, remarks, evidence, attachmentId: meta ? meta.id : null, submittedAt: nowIso() };
  await db.reviews.update(() => {
    r.userResponse = resp;
    (r.responseHistory = r.responseHistory || []).push(resp);
    if (meta) (r.attachments = r.attachments || []).push(meta);
    r.status = 'pending_admin_review';
    if (type === 'change_requested') r.changeStatus = 'change_requested';
    r.updatedAt = resp.submittedAt;
  });
  const labels = { accepted: 'accepted', clarification_requested: 'requested clarification on', change_requested: 'requested a change on' };
  await notifyAdmins({ type: 'user_response', title: 'Employee response received', message: `${user.fullName} ${labels[type]} ${r.controlId} (${r.period}).`, reviewId: r.id });
  sendJson(res, 200, { review: redactForUser(r) });
});

route('POST', '/api/me/reviews/:id/complete-changes', { auth: 'user', bodyLimit: CONFIG.uploadJsonLimit }, async ({ res, params, user, body }) => {
  const r = getReviewOr404(params.id);
  if (r.userId !== user.id) throw new HttpError(404, 'Review not found');
  if (r.changeStatus !== 'awaiting_changes') {
    throw new HttpError(409, 'Changes can only be marked complete after the reviewer has approved your change request');
  }
  const remarks = reqStr(body.remarks, 4000, 'remarks', 3);
  const evidence = optStr(body.evidence, 1000, 'evidence');
  const meta = await persistAttachment(prepareAttachment(body.attachment, user, 'change_completion'));
  await db.reviews.update(() => {
    r.changeCompletion = { remarks, evidence, attachmentId: meta ? meta.id : null, completedAt: nowIso() };
    if (meta) (r.attachments = r.attachments || []).push(meta);
    r.changeStatus = 'changes_completed';
    r.updatedAt = r.changeCompletion.completedAt;
  });
  await notifyAdmins({ type: 'changes_completed', title: 'Changes ready for verification', message: `${user.fullName} completed changes on ${r.controlId} (${r.period}).`, reviewId: r.id });
  sendJson(res, 200, { review: redactForUser(r) });
});

function listNotifications(res, userId) {
  const mine = db.notifications.get().filter((n) => n.recipientId === userId);
  const unread = mine.filter((n) => !n.read).length;
  sendJson(res, 200, { notifications: mine.slice(-100).reverse(), unread });
}
async function markRead(res, userId, id) {
  const n = db.notifications.get().find((x) => x.id === id && x.recipientId === userId);
  if (!n) throw new HttpError(404, 'Notification not found');
  await db.notifications.update(() => { n.read = true; n.readAt = nowIso(); });
  sendJson(res, 200, { ok: true });
}
async function markAllRead(res, userId) {
  const t = nowIso();
  await db.notifications.update((list) => list.forEach((n) => { if (n.recipientId === userId && !n.read) { n.read = true; n.readAt = t; } }));
  sendJson(res, 200, { ok: true });
}

route('GET', '/api/me/notifications', { auth: 'user' }, ({ res, user }) => listNotifications(res, user.id));
route('POST', '/api/me/notifications/read-all', { auth: 'user' }, ({ res, user }) => markAllRead(res, user.id));
route('POST', '/api/me/notifications/:id/read', { auth: 'user' }, ({ res, user, params }) => markRead(res, user.id, params.id));

/* ========================================================================== *
 *  ROUTES — ADMIN PORTAL
 * ========================================================================== */
route('GET', '/api/admin/notifications', { auth: 'admin' }, ({ res, user }) => listNotifications(res, user.id));
route('POST', '/api/admin/notifications/read-all', { auth: 'admin' }, ({ res, user }) => markAllRead(res, user.id));
route('POST', '/api/admin/notifications/:id/read', { auth: 'admin' }, ({ res, user, params }) => markRead(res, user.id, params.id));

route('GET', '/api/admin/reviews', { auth: 'admin' }, ({ res, query }) => {
  const list = filterReviews(db.reviews.get(), query, true);
  sendJson(res, 200, { reviews: list.map(adminView), count: list.length, availableYears: availableYears(db.reviews.get()) });
});

route('GET', '/api/admin/reviews/export', { auth: 'admin' }, ({ res, query }) => {
  sendCsv(res, exportName('qar_reviews_admin', query), buildAdminCsv(filterReviews(db.reviews.get(), query, true)));
});

route('GET', '/api/admin/reviews/:id', { auth: 'admin' }, ({ res, params }) => sendJson(res, 200, { review: adminView(getReviewOr404(params.id)) }));

route('POST', '/api/admin/reviews', { auth: 'admin' }, async ({ res, user, body }) => {
  const employee = findUser(typeof body.userId === 'string' ? body.userId : '');
  if (!employee || employee.role !== 'user') throw bad('userId must reference an employee (user role) account');
  if (employee.active === false) throw bad('Cannot issue a review to a disabled account');
  const { period, year, month } = parsePeriod(body.period);
  const control = defs.getControl(body.controlId);
  if (!control) throw bad('controlId must be one of the 50 catalog controls');
  if (db.reviews.get().some((r) => r.userId === employee.id && r.period === period && r.controlId === control.id)) {
    throw new HttpError(409, `A review for ${control.id} already exists for this employee in ${period}`);
  }
  const t = nowIso();
  const review = applyScore({
    id: newId('qar'), userId: employee.id, employeeName: employee.fullName,
    period, year, month,
    controlId: control.id, controlName: control.name,
    checks: mergeChecks(body.checks, null, true),
    check_remarks: mergeCheckRemarks(body.check_remarks, null),
    overall_comment: optStr(body.overall_comment, 4000, 'overall_comment'),
    admin_internal_notes: optStr(body.admin_internal_notes, 4000, 'admin_internal_notes'),
    visibility: mergeVisibility(body.visibility, null),
    status: 'issued', changeStatus: 'none',
    userResponse: null, responseHistory: [], adminResolution: null,
    changeCompletion: null, changesVerifiedAt: null, changesVerifiedBy: null, changesVerifiedById: null, verificationNote: '',
    feedbackThread: [], attachments: [],
    createdAt: t, createdBy: user.id, createdByName: user.fullName, updatedAt: t, updatedBy: user.id
  });
  await db.reviews.update((list) => list.push(review));
  await notify([employee.id], {
    type: 'review_issued', title: 'New QAR review issued',
    message: `${control.id} – ${control.name} (${period})` + (review.visibility.overall_comment && review.overall_comment ? ' — reviewer remarks added.' : '.'),
    reviewId: review.id
  });
  sendJson(res, 201, { review: adminView(review) });
});

route('PUT', '/api/admin/reviews/:id', { auth: 'admin' }, async ({ res, params, user, body }) => {
  const r = getReviewOr404(params.id);
  const before = JSON.stringify({ ...redactForUser(r), updatedAt: null });
  const next = { ...r };
  if (body.period !== undefined) Object.assign(next, parsePeriod(body.period));
  if (body.controlId !== undefined) {
    const c = defs.getControl(body.controlId);
    if (!c) throw bad('controlId must be one of the 50 catalog controls');
    next.controlId = c.id; next.controlName = c.name;
  }
  if ((next.period !== r.period || next.controlId !== r.controlId) &&
      db.reviews.get().some((x) => x.id !== r.id && x.userId === r.userId && x.period === next.period && x.controlId === next.controlId)) {
    throw new HttpError(409, 'Another review already exists for this employee, period and control');
  }
  next.checks = mergeChecks(body.checks, r.checks, false);
  next.check_remarks = mergeCheckRemarks(body.check_remarks, r.check_remarks);
  if (body.overall_comment !== undefined) next.overall_comment = optStr(body.overall_comment, 4000, 'overall_comment');
  if (body.admin_internal_notes !== undefined) next.admin_internal_notes = optStr(body.admin_internal_notes, 4000, 'admin_internal_notes');
  next.visibility = mergeVisibility(body.visibility, r.visibility);
  applyScore(next);
  next.updatedAt = nowIso(); next.updatedBy = user.id;

  await db.reviews.update(() => Object.assign(r, next));
  // Notify only if something the employee can actually see changed (no leakage of internal edits).
  if (JSON.stringify({ ...redactForUser(r), updatedAt: null }) !== before) {
    const remarksChanged = body.overall_comment !== undefined && r.visibility.overall_comment;
    await notify([r.userId], {
      type: remarksChanged ? 'reviewer_remarks' : 'review_updated',
      title: remarksChanged ? 'Reviewer remarks updated' : 'QAR review updated',
      message: `${r.controlId} – ${r.controlName} (${r.period}) was updated by the reviewer.`, reviewId: r.id
    });
  }
  sendJson(res, 200, { review: adminView(r) });
});

route('DELETE', '/api/admin/reviews/:id', { auth: 'admin' }, async ({ res, params }) => {
  const r = getReviewOr404(params.id);
  await db.reviews.update((list) => { const i = list.indexOf(r); if (i >= 0) list.splice(i, 1); });
  await db.notifications.update((list) => { for (let i = list.length - 1; i >= 0; i--) if (list[i].reviewId === r.id) list.splice(i, 1); });
  for (const a of r.attachments || []) await fs.promises.unlink(path.join(EVIDENCE_DIR, a.id)).catch(() => {});
  sendJson(res, 200, { ok: true, id: r.id });
});

/** Admin resolves the employee's response: { note, decision: 'approved' | 'rejected' } */
route('POST', '/api/admin/reviews/:id/resolve-response', { auth: 'admin' }, async ({ res, params, user, body }) => {
  const r = getReviewOr404(params.id);
  if (r.status !== 'pending_admin_review' || !r.userResponse) throw new HttpError(409, 'There is no employee response awaiting resolution');
  const note = reqStr(body.note, 4000, 'note', 3);
  const decision = body.decision === undefined ? 'approved' : body.decision;
  if (!['approved', 'rejected'].includes(decision)) throw bad('decision must be approved or rejected');
  const t = nowIso();
  await db.reviews.update(() => {
    r.adminResolution = { note, decision, resolvedAt: t, resolvedBy: user.id, resolvedByName: user.fullName, responseType: r.userResponse.type };
    r.status = 'resolved';
    if (r.userResponse.type === 'change_requested') r.changeStatus = decision === 'approved' ? 'awaiting_changes' : 'none';
    r.updatedAt = t;
  });
  const msg = r.changeStatus === 'awaiting_changes'
    ? `Your change request on ${r.controlId} (${r.period}) was approved. Please implement and mark changes as completed.`
    : `The reviewer responded to your ${r.userResponse.type.replace(/_/g, ' ')} on ${r.controlId} (${r.period}).`;
  await notify([r.userId], { type: 'response_resolved', title: 'Reviewer resolution posted', message: msg, reviewId: r.id });
  sendJson(res, 200, { review: adminView(r) });
});

/** Admin verifies completed changes: { note?, action: 'verify' (default) | 'reopen' } */
route('POST', '/api/admin/reviews/:id/verify-changes', { auth: 'admin' }, async ({ res, params, user, body }) => {
  const r = getReviewOr404(params.id);
  if (r.changeStatus !== 'changes_completed') throw new HttpError(409, 'Only reviews with completed changes can be verified');
  const action = body.action === undefined ? 'verify' : body.action;
  if (!['verify', 'reopen'].includes(action)) throw bad('action must be verify or reopen');
  const note = action === 'reopen' ? reqStr(body.note, 4000, 'note', 3) : optStr(body.note, 4000, 'note');
  const t = nowIso();
  await db.reviews.update(() => {
    r.verificationNote = note;
    if (action === 'verify') {
      r.changeStatus = 'changes_verified';
      r.changesVerifiedAt = t; r.changesVerifiedBy = user.fullName; r.changesVerifiedById = user.id;
    } else {
      r.changeStatus = 'awaiting_changes';
    }
    r.updatedAt = t;
  });
  await notify([r.userId], {
    type: action === 'verify' ? 'changes_verified' : 'changes_reopened',
    title: action === 'verify' ? 'Changes verified' : 'Further changes required',
    message: action === 'verify'
      ? `Your changes on ${r.controlId} (${r.period}) were verified by ${user.fullName}.`
      : `The reviewer requested further changes on ${r.controlId} (${r.period}).`,
    reviewId: r.id
  });
  sendJson(res, 200, { review: adminView(r) });
});

/* ---- User management ---------------------------------------------------- */
route('GET', '/api/admin/users', { auth: 'admin' }, ({ res }) => {
  const counts = {};
  db.reviews.get().forEach((r) => { counts[r.userId] = (counts[r.userId] || 0) + 1; });
  const users = db.users.get().map((u) => ({ ...publicUser(u), reviewCount: counts[u.id] || 0 }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  sendJson(res, 200, { users });
});

route('POST', '/api/admin/users', { auth: 'admin' }, async ({ res, body }) => {
  const username = reqStr(body.username, 40, 'username');
  if (!USERNAME_RE.test(username)) throw bad('Username must be 3-40 characters: letters, numbers, . _ @ -');
  if (findUserByName(username)) throw new HttpError(409, 'Username already exists');
  const fullName = reqStr(body.fullName, 120, 'fullName', 2);
  const email = optStr(body.email, 200, 'email');
  if (email && !EMAIL_RE.test(email)) throw bad('Invalid email address');
  if (email && emailTaken(email)) throw new HttpError(409, 'Email address is already used by another account');
  const role = body.role === undefined ? 'user' : body.role;
  if (!['admin', 'user'].includes(role)) throw bad('role must be admin or user');
  const { salt, hash } = sec.hashPassword(validatePassword(body.password));
  const t = nowIso();
  const u = {
    id: newId('usr'), username, fullName, email, department: optStr(body.department, 120, 'department'),
    role, active: true, salt, passwordHash: hash, mustChangePassword: body.mustChangePassword !== false,
    createdAt: t, updatedAt: t, lastLoginAt: null
  };
  await db.users.update((list) => list.push(u));
  sendJson(res, 201, { user: publicUser(u) });
});

route('PUT', '/api/admin/users/:id', { auth: 'admin' }, async ({ res, params, user, session, body }) => {
  const u = findUser(params.id);
  if (!u) throw new HttpError(404, 'User not found');
  const prevRole = u.role;
  const patch = {};
  if (body.fullName !== undefined) patch.fullName = reqStr(body.fullName, 120, 'fullName', 2);
  if (body.email !== undefined) {
    patch.email = optStr(body.email, 200, 'email');
    if (patch.email && !EMAIL_RE.test(patch.email)) throw bad('Invalid email address');
    if (patch.email && emailTaken(patch.email, u.id)) throw new HttpError(409, 'Email address is already used by another account');
  }
  if (body.department !== undefined) patch.department = optStr(body.department, 120, 'department');
  if (body.role !== undefined) {
    if (!['admin', 'user'].includes(body.role)) throw bad('role must be admin or user');
    patch.role = body.role;
  }
  if (body.active !== undefined) patch.active = optBool(body.active, 'active');
  const demoting = (patch.role && patch.role !== 'admin') || patch.active === false;
  if (u.role === 'admin' && demoting) {
    if (u.id === user.id) throw bad('You cannot demote or disable your own account');
    if (activeAdmins().length <= 1) throw bad('At least one active administrator is required');
  }
  let pw = null;
  if (body.password !== undefined && body.password !== '') pw = sec.hashPassword(validatePassword(body.password));
  await db.users.update(() => {
    Object.assign(u, patch);
    if (pw) { u.salt = pw.salt; u.passwordHash = pw.hash; u.mustChangePassword = u.id !== user.id; }
    u.updatedAt = nowIso();
  });
  // Force re-login after a password reset, deactivation or role change (keep the acting admin's own session).
  if (pw || patch.active === false || (patch.role && patch.role !== prevRole)) {
    await revokeSessions(u.id, u.id === user.id ? session.idHash : undefined);
  }
  sendJson(res, 200, { user: publicUser(u) });
});

route('DELETE', '/api/admin/users/:id', { auth: 'admin' }, async ({ res, params, user, query }) => {
  const u = findUser(params.id);
  if (!u) throw new HttpError(404, 'User not found');
  if (u.id === user.id) throw bad('You cannot delete your own account');
  if (u.role === 'admin' && activeAdmins().filter((a) => a.id !== u.id).length < 1) throw bad('At least one active administrator is required');
  const owned = db.reviews.get().filter((r) => r.userId === u.id);
  if (owned.length && query.get('cascade') !== 'true') {
    throw new HttpError(409, `This user has ${owned.length} review(s). Deactivate the account instead, or delete with cascade.`, { reviewCount: owned.length });
  }
  await db.reviews.update((list) => { for (let i = list.length - 1; i >= 0; i--) if (list[i].userId === u.id) list.splice(i, 1); });
  await db.notifications.update((list) => { for (let i = list.length - 1; i >= 0; i--) if (list[i].recipientId === u.id) list.splice(i, 1); });
  await revokeSessions(u.id);
  await db.users.update((list) => { const i = list.indexOf(u); if (i >= 0) list.splice(i, 1); });
  sendJson(res, 200, { ok: true, deletedReviews: owned.length });
});

/* ========================================================================== *
 *  STATIC FILES (with server-side portal guards)
 * ========================================================================== */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};

function redirect(res, location) { res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' }); res.end(); }

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch (_) { res.writeHead(400); return res.end('Bad request'); }
  if (pathname.includes('\0')) { res.writeHead(400); return res.end('Bad request'); }

  if (pathname === '/' || pathname === '/index.html') return redirect(res, '/login.html');
  if (pathname === '/favicon.ico') return redirect(res, '/favicon.svg');
  if (pathname === '/admin' || pathname === '/admin/') return redirect(res, '/admin/login.html');

  // Server-side portal guards
  const auth = getAuth(parseCookies(req.headers.cookie));
  if (pathname === '/dashboard.html' && (!auth || auth.user.role !== 'user')) return redirect(res, auth && auth.user.role === 'admin' ? '/admin/dashboard.html' : '/login.html');
  if (pathname === '/admin/dashboard.html' && (!auth || auth.user.role !== 'admin')) return redirect(res, auth && auth.user.role === 'user' ? '/dashboard.html' : '/admin/login.html');
  if (pathname === '/login.html' && auth && auth.user.role === 'user') return redirect(res, '/dashboard.html');
  if (pathname === '/admin/login.html' && auth && auth.user.role === 'admin') return redirect(res, '/admin/dashboard.html');

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  let stat;
  try { stat = await fs.promises.stat(filePath); } catch (_) { stat = null; }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 — Not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

/* ========================================================================== *
 *  HTTP SERVER
 * ========================================================================== */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  setSecurityHeaders(req, res);
  try {
    // Global CORS preflight
    if (req.method === 'OPTIONS') {
      applyCors(req, res);
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
        'Access-Control-Max-Age': '600', 'Content-Length': '0'
      });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) {
      applyCors(req, res);
      return await handleApi(req, res, url);
    }
    return await serveStatic(req, res, url);
  } catch (err) {
    if (res.headersSent) { try { res.end(); } catch (_) { /* ignore */ } return; }
    if (err instanceof HttpError) {
      return sendJson(res, err.status, { error: err.extra.error || 'error', message: err.message, ...err.extra });
    }
    console.error('[server] Unhandled error:', err);
    return sendJson(res, 500, { error: 'server_error', message: 'Internal server error' });
  }
});
server.headersTimeout = 30000;
server.requestTimeout = 60000;

/** Lists IPv4 addresses so LAN colleagues can connect. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}

function printBanner() {
  const p = CONFIG.port;
  console.log('\n  ==============================================================');
  console.log('   NWC Quality Assurance Review (QAR) — server is running');
  console.log('  ==============================================================');
  console.log(`   This PC       : http://localhost:${p}/login.html`);
  console.log(`   Admin portal  : http://localhost:${p}/admin/login.html`);
  const lan = lanAddresses();
  if (lan.length) {
    console.log('   Office LAN    : share one of these with colleagues');
    lan.forEach((a) => console.log(`                   http://${a.address}:${p}/login.html   (${a.name})`));
  } else {
    console.log('   Office LAN    : no network adapter detected');
  }
  console.log(`   Data folder   : ${CONFIG.dataDir}`);
  console.log(`   Proxy trusted : ${CONFIG.trustProxy ? 'yes' : 'no'}   (set TRUST_PROXY=true behind a reverse proxy)`);
  console.log('  ==============================================================\n');
}

/** Hourly purge of expired sessions. */
setInterval(() => {
  const t = Date.now();
  if (db.sessions.get().some((s) => Date.parse(s.expiresAt) <= t)) {
    db.sessions.update((list) => { for (let i = list.length - 1; i >= 0; i--) if (Date.parse(list[i].expiresAt) <= t) list.splice(i, 1); });
  }
}, 60 * 60 * 1000).unref();

async function shutdown(signal) {
  console.log(`\n[server] ${signal} received — flushing data and shutting down...`);
  for (const set of sseClients.values()) for (const r of set) { try { r.end(); } catch (_) { /* ignore */ } }
  server.close();
  await Promise.all(Object.values(db).map((s) => s.flush()));
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  if (process.argv.includes('--reset-admin-password')) {
    const admin = db.users.get().find((u) => u.role === 'admin');
    if (!admin) { await seedAdmin(); process.exit(0); }
    const pw = generatePassword();
    const { salt, hash } = sec.hashPassword(pw);
    await db.users.update(() => { admin.salt = salt; admin.passwordHash = hash; admin.active = true; admin.mustChangePassword = true; admin.updatedAt = nowIso(); });
    await revokeSessions(admin.id);
    console.log(`\n  Admin "${admin.username}" password reset to: ${pw}\n  Change it after signing in.\n`);
    process.exit(0);
  }
  await seedAdmin();
  if (process.env.RENDER && !process.env.DATA_DIR) {
    console.warn('[storage] WARNING: running on Render without a persistent disk. Users, reviews and evidence are');
    console.warn('[storage]          erased on every restart/redeploy. Attach a disk and set DATA_DIR (see README).');
  }
  if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
    console.warn('[security] Tip: set SESSION_SECRET (32+ random characters) so sessions survive restarts.');
  }
  server.listen(CONFIG.port, CONFIG.host, () => {
    printBanner();
    console.log(`QAR_SERVER_READY port=${server.address().port}`);
  });
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { server, CONFIG };
