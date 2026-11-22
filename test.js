#!/usr/bin/env node
'use strict';
/**
 * ============================================================================
 *  QAR automated verification suite (specification minimum: 132 checks)
 *  Boots the real server on a free port with an ISOLATED, TEMPORARY data
 *  directory (production ./data is never touched), exercises every feature
 *  over HTTP and tears everything down.
 *
 *  Run:  node test.js        (exit code 0 = all checks passed)
 *  Used as the release gate by launch.js, Dockerfile, render.yaml and CI.
 * ============================================================================
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA_DIR = path.join(__dirname, `.test-data-${process.pid}`);
const ADMIN_USER = 'qa.admin';
const ADMIN_PASS = 'AdminPass123';
const MIN_CHECKS = 132;
const CUR_YEAR = new Date().getFullYear();
const NEXT_YEAR = CUR_YEAR + 1;

/** Official NWC control catalog (order as approved). */
const OFFICIAL_CONTROLS = [
  ['C.01', 'Validation of new connections with previous outstanding amounts'], ['C.02', 'Customer segmentation validation'],
  ['C.03', 'Customer request status SLA Monitoring'], ['C.05', 'Quotation accuracy validation'],
  ['C.06', 'Connection payment reminder validation'], ['C.07', 'Implementation Work Order Generation and Payment Validation'],
  ['C.08', 'Service Agreement Activation Validation'], ['C.09', 'Connection fee vs. contractor cost analysis'],
  ['C.10', 'Core revenue recording validation'], ['C.11', 'Connection disconnection validation'],
  ['C.12', 'AMR vs. CC&B meter validation'], ['C.13', 'AMR vs. MDM vs. CC&B validation'], ['C.14', 'MDM reading validation'],
  ['C.15', 'Bulk meters AMR vs. CC&B validation'], ['C.16', 'Zero consumption monitoring'], ['C.17', 'Low consumption monitoring'],
  ['C.18', 'Meter alarm monitoring'], ['C.19', 'Block bills validation'], ['C.20', 'Billing/reading cycle assignment'],
  ['C.21', 'Billable vs. Billed validation'], ['C.22', 'Charging validation'], ['C.23', 'CC&B vs. SADAD validation'],
  ['C.24', 'High usage notification validation'], ['C.25', 'Estimated bill validation'], ['C.26', 'Bill delivery validation'],
  ['C.27', 'SADAD vs. Billing validation'], ['C.28', 'Billing adjustment validation'], ['C.29', 'Liquidation & Final invoice validation'],
  ['C.30', 'Reconnection validation'], ['C.31', 'Payment instalment validation'], ['C.32', 'Dunning validation'],
  ['C.33', 'Outstanding ageing monitoring'], ['C.34', 'Disconnection field activity monitoring'], ['C.35', 'Water Tanker request validation'],
  ['C.36', 'Outstanding monitoring'], ['C.37', 'Tanker station charging validation'], ['C.38', 'Water tanker quality fee validation'],
  ['C.39', 'Water tanker registration fee and revenue recording validation'], ['C.40', 'Waste water tanker entry fee validation'],
  ['C.41', 'Waste water tanker entry fee revenue share validation'], ['C.42', 'Waste water tanker registration fee and revenue recording validation'],
  ['C.43', 'TSE invoice validation'], ['C.44', 'Water sample testing service charge validation'], ['C.45', 'Water sample testing payment validation'],
  ['C.46', 'Water sample testing revenue recording validation'], ['C.47', 'Bidding fee validation'], ['C.48', 'Bidding fee revenue recording validation'],
  ['C.49', 'Contractor penalty revenue recording validation'], ['C.55', 'NRW Monitoring'], ['C.54', 'Zamzam revenue recording validation']
];

let passed = 0; let failed = 0; let ipCounter = 10;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; failures.push(name); console.log(`  \u2717 ${name}${detail !== undefined ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
function section(t) { console.log(`\n\u25B6 ${t}`); }

/* ---------------------------------------------------------------------------
 * Minimal HTTP client with a cookie jar (one per simulated browser)
 * ------------------------------------------------------------------------- */
class Client {
  constructor(ip) { this.cookies = {}; this.ip = ip || `10.0.0.${ipCounter++}`; }
  get csrf() { return this.cookies.csrf_token || ''; }
  request(method, url, body, opts = {}) {
    return new Promise((resolve, reject) => {
      const headers = { 'X-Forwarded-For': this.ip, ...(opts.headers || {}) };
      const cookieStr = Object.entries(this.cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
      if (cookieStr && !opts.noCookies) headers.Cookie = cookieStr;
      if (opts.csrf !== false && method !== 'GET' && !('x-csrf-token' in headers)) headers['x-csrf-token'] = this.csrf;
      let payload;
      if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
      const req = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          for (const sc of [].concat(res.headers['set-cookie'] || [])) {
            const [pair] = sc.split(';'); const i = pair.indexOf('=');
            const k = pair.slice(0, i).trim(); const v = decodeURIComponent(pair.slice(i + 1));
            if (/Max-Age=0/i.test(sc) || v === '') delete this.cookies[k]; else this.cookies[k] = v;
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json, setCookie: [].concat(res.headers['set-cookie'] || []) });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  get(u, o) { return this.request('GET', u, undefined, o); }
  post(u, b, o) { return this.request('POST', u, b, o); }
  put(u, b, o) { return this.request('PUT', u, b, o); }
  del(u, o) { return this.request('DELETE', u, undefined, o); }
  login(username, password, portal) { return this.post('/api/login', { username, password, portal }, { csrf: false }); }
}

/* ---------------------------------------------------------------------------
 * Server lifecycle (isolated test environment)
 * ------------------------------------------------------------------------- */
let serverProc;
function startServer(envOverride, keepData) {
  if (!keepData) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, TRUST_PROXY: 'true', ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS, ADMIN_EMAIL: '', SESSION_SECRET: '', ...(envOverride || {}) };
    serverProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${out}`)), 15000);
    serverProc.stdout.on('data', (d) => { out += d; if (out.includes('QAR_SERVER_READY')) { clearTimeout(timer); resolve(); } });
    serverProc.stderr.on('data', (d) => { out += d; });
    serverProc.on('exit', (code) => { clearTimeout(timer); if (code) reject(new Error(`Server exited (${code}):\n${out}`)); });
  });
}
/** Stops the server but keeps the data directory (simulates a restart / redeploy). */
function haltServer() {
  return new Promise((resolve) => {
    if (!serverProc || serverProc.exitCode !== null) return resolve();
    serverProc.once('exit', () => setTimeout(resolve, 100));
    serverProc.kill('SIGTERM');
  });
}
/** Starts a server that is expected to refuse to boot; resolves with its exit code. */
function expectBootFailure(envOverride) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, PORT: String(PORT + 1), HOST: '127.0.0.1', DATA_DIR: DATA_DIR + '-bad', ADMIN_USERNAME: 'admin', ...envOverride }, stdio: 'ignore'
    });
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve(-1); }, 10000);
    p.on('exit', (code) => { clearTimeout(t); fs.rmSync(DATA_DIR + '-bad', { recursive: true, force: true }); resolve(code); });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    const cleanup = () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ } resolve(); };
    if (!serverProc || serverProc.exitCode !== null) return cleanup();
    serverProc.once('exit', () => setTimeout(cleanup, 100));
    serverProc.kill('SIGTERM');
    setTimeout(() => { try { serverProc.kill('SIGKILL'); } catch (_) { /* ignore */ } }, 3000).unref();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allDone = (extra = {}) => ({ controls_performed: 'done', performed_on_time: 'done', evidences_uploaded: 'done', followup_done: 'done', correct_count_entered: 'done', ...extra });

/* ---------------------------------------------------------------------------
 * Test suite
 * ------------------------------------------------------------------------- */
async function run() {
  await startServer();
  const anon = new Client();
  const admin = new Client();
  const alice = new Client();
  const bob = new Client();

  /* 1. Definitions & catalog ------------------------------------------------ */
  section('1. Definitions & official 50-control catalog');
  const d = await anon.get('/api/definitions');
  check('GET /api/definitions returns 200', d.status === 200);
  const defs = d.json || {};
  check('Exactly 5 rubric checks', Array.isArray(defs.checks) && defs.checks.length === 5);
  check('Rubric check keys in canonical order',
    JSON.stringify((defs.checks || []).map((c) => c.key)) === JSON.stringify(['controls_performed', 'performed_on_time', 'evidences_uploaded', 'followup_done', 'correct_count_entered']));
  check('Check labels match specification', (defs.checks || []).map((c) => c.label).join('|') === 'Controls performed?|Performed on time?|Evidences uploaded?|Follow-up done?|Correct count entered?');
  check('controls_performed flagged as critical', defs.checks && defs.checks[0].critical === true);
  check('Point values Done=1 / Partial=0.5 / Not Done=0', defs.points && defs.points.done === 1 && defs.points.partial === 0.5 && defs.points.not_done === 0);
  check('Max points is 5.0', defs.maxPoints === 5);
  check('Exactly 50 monthly controls', Array.isArray(defs.controls) && defs.controls.length === 50);
  const ids = (defs.controls || []).map((c) => c.id);
  check('Catalog IDs, names and order match the official list exactly',
    JSON.stringify((defs.controls || []).map((c) => [c.id, c.name])) === JSON.stringify(OFFICIAL_CONTROLS));
  check('C.01 is "Validation of new connections with previous outstanding amounts"', defs.controls && defs.controls[0].name === 'Validation of new connections with previous outstanding amounts');
  check('C.55 "NRW Monitoring" present', (defs.controls || []).some((c) => c.id === 'C.55' && c.name === 'NRW Monitoring'));
  check('C.54 "Zamzam revenue recording validation" present', (defs.controls || []).some((c) => c.id === 'C.54' && c.name === 'Zamzam revenue recording validation'));
  check('C.04 and C.50 – C.53 are not in the catalog', ['C.04', 'C.50', 'C.51', 'C.52', 'C.53'].every((x) => !ids.includes(x)));
  check('Control IDs are unique', new Set(ids).size === ids.length);
  check('Scoring override rule published', defs.scoring && /0%/.test(defs.scoring.overrideRule));
  check('Three response types published', defs.responseTypes && defs.responseTypes.map((t) => t.key).sort().join() === 'accepted,change_requested,clarification_requested');
  check('Health endpoint responds ok', (await anon.get('/api/health')).json.status === 'ok');

  /* 2. Auth, CSRF & preflight ---------------------------------------------- */
  section('2. Authentication, sessions, CSRF & preflight');
  const tok = await anon.get('/api/csrf-token');
  check('GET /api/csrf-token returns a token', tok.status === 200 && typeof tok.json.csrfToken === 'string' && tok.json.csrfToken.length >= 32);
  check('Anonymous token marked unauthenticated', tok.json.authenticated === false);
  const fresh = new Client();
  const fl = await fresh.request('POST', '/api/login', { username: ADMIN_USER, password: ADMIN_PASS, portal: 'admin' }, { csrf: false });
  check('Fresh device (no cookies) can log in', fl.status === 200);
  const adminLogin = await admin.login(ADMIN_USER, ADMIN_PASS, 'admin');
  check('Admin login succeeds on admin portal', adminLogin.status === 200 && adminLogin.json.user.role === 'admin');
  const sc = adminLogin.setCookie.join(' || ');
  check('Session cookie is HttpOnly', /session=[^;]+;[^|]*HttpOnly/.test(sc));
  check('Session cookie is SameSite=Lax', /session=[^|]*SameSite=Lax/.test(sc));
  check('Session cookie TTL is 7 days (604800s)', /session=[^|]*Max-Age=604800/.test(sc));
  check('Session cookie is signed (<id>.<sig>)', /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(admin.cookies.session || ''));
  check('CSRF cookie issued at login and matches response', admin.cookies.csrf_token && admin.cookies.csrf_token === adminLogin.json.csrfToken);
  check('CSRF cookie is readable by JS (not HttpOnly)', !/csrf_token=[^|]*HttpOnly/.test(sc));
  check('Secure flag absent on plain HTTP', !/Secure/.test(sc));
  const secureLogin = await new Client().request('POST', '/api/login', { username: ADMIN_USER, password: ADMIN_PASS, portal: 'admin' }, { csrf: false, headers: { 'X-Forwarded-Proto': 'https' } });
  check('Secure flag set behind HTTPS proxy (x-forwarded-proto)', secureLogin.setCookie.every((c) => /Secure/.test(c)));
  check('Login response does not leak password hash/salt', !/passwordHash|"salt"/.test(adminLogin.text));
  const me = await admin.get('/api/me');
  check('GET /api/me returns the admin profile', me.status === 200 && me.json.user.username === ADMIN_USER);
  check('GET /api/me unauthenticated -> 401', (await anon.get('/api/me')).status === 401);
  const at = await admin.get('/api/csrf-token');
  check('Authenticated CSRF token equals session token', at.json.authenticated === true && at.json.csrfToken === admin.csrf);
  check('Tampered session signature rejected', (await new Client().get('/api/me', { headers: { Cookie: `session=${admin.cookies.session.slice(0, -2)}xx` } })).status === 401);
  check('Wrong password -> 401', (await new Client().login(ADMIN_USER, 'nope-wrong-1', 'admin')).status === 401);
  check('Unknown user -> 401 (same message)', (await new Client().login('ghost.user', 'whatever123', 'admin')).json.message === 'Invalid username or password');

  const noCsrf = await admin.post('/api/admin/users', { username: 'alice', fullName: 'Alice Employee', password: 'AlicePass123', role: 'user' }, { csrf: false });
  check('Mutating request WITHOUT CSRF token -> 403', noCsrf.status === 403 && noCsrf.json.error === 'csrf');
  const badCsrf = await admin.post('/api/admin/users', { username: 'alice', fullName: 'Alice Employee', password: 'AlicePass123', role: 'user' }, { headers: { 'x-csrf-token': 'forged-token' } });
  check('Mutating request with WRONG CSRF token -> 403', badCsrf.status === 403);
  const otherSessionToken = await admin.post('/api/admin/users', { username: 'alice', fullName: 'Alice Employee', password: 'AlicePass123' }, { headers: { 'x-csrf-token': fresh.csrf } });
  check('CSRF token of another session rejected', otherSessionToken.status === 403);
  const cu = await admin.post('/api/admin/users', { username: 'alice', fullName: 'Alice Employee', email: 'alice@nwc.example', department: 'Billing', password: 'AlicePass123', role: 'user' });
  check('Admin creates user with valid CSRF token -> 201', cu.status === 201 && cu.json.user.role === 'user');
  const aliceId = cu.json && cu.json.user.id;
  const cb = await admin.post('/api/admin/users', { username: 'bob', fullName: 'Bob Employee', password: 'BobPass1234', role: 'user' });
  const bobId = cb.json && cb.json.user.id;
  check('Second employee created', cb.status === 201);
  check('Duplicate username -> 409', (await admin.post('/api/admin/users', { username: 'ALICE', fullName: 'Dup', password: 'Whatever123' })).status === 409);
  check('Weak password rejected -> 400', (await admin.post('/api/admin/users', { username: 'weak', fullName: 'Weak Pw', password: 'short' })).status === 400);
  check('Created user response excludes hash', !/passwordHash/.test(cu.text));
  const users = await admin.get('/api/admin/users');
  check('GET /api/admin/users lists 3 accounts without secrets', users.json.users.length === 3 && !/passwordHash|salt/.test(users.text));
  const persisted = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8'));
  const alicePersisted = persisted.find((u) => u.username === 'alice');
  check('users.json stores scrypt hash + 16-byte salt, never plaintext', alicePersisted && alicePersisted.salt.length === 32 && alicePersisted.passwordHash.length === 128 && !fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8').includes('AlicePass123'));
  check('Per-user salts are unique', new Set(persisted.map((u) => u.salt)).size === persisted.length);
  check('.session_secret generated', fs.existsSync(path.join(DATA_DIR, '.session_secret')) && fs.readFileSync(path.join(DATA_DIR, '.session_secret'), 'utf8').length >= 64);
  const sessFile = fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8');
  check('sessions.json stores hashed ids with expiry', /"idHash"/.test(sessFile) && /"expiresAt"/.test(sessFile) && !sessFile.includes(admin.cookies.session.split('.')[0]));
  const pre = await anon.request('OPTIONS', '/api/admin/reviews', undefined, { headers: { Origin: `http://127.0.0.1:${PORT}`, 'Access-Control-Request-Method': 'POST' } });
  check('OPTIONS preflight -> 204', pre.status === 204);
  check('Preflight returns Allow-Methods & Allow-Headers', /POST/.test(pre.headers['access-control-allow-methods'] || '') && /x-csrf-token/i.test(pre.headers['access-control-allow-headers'] || ''));
  check('Preflight echoes same-origin with credentials', pre.headers['access-control-allow-origin'] === `http://127.0.0.1:${PORT}` && pre.headers['access-control-allow-credentials'] === 'true');
  const evil = await admin.post('/api/admin/users', { username: 'evil', fullName: 'Evil', password: 'EvilPass123' }, { headers: { Origin: 'https://evil.example' } });
  check('Cross-origin mutating request rejected', evil.status === 403);

  /* 3. Portal isolation ---------------------------------------------------- */
  section('3. Portal isolation & role mismatch');
  const mis1 = await new Client().login('alice', 'AlicePass123', 'admin');
  check('User on admin portal -> 403', mis1.status === 403);
  check('Role mismatch error code returned', mis1.json && mis1.json.error === 'role_mismatch');
  check('Role mismatch links to /login.html', mis1.json && mis1.json.redirect === '/login.html');
  check('Role mismatch does not set a session', !(mis1.setCookie.join('').includes('session=')));
  const mis2 = await new Client().login(ADMIN_USER, ADMIN_PASS, 'user');
  check('Admin on user portal -> 403 linking to /admin/login.html', mis2.status === 403 && mis2.json.redirect === '/admin/login.html');
  const al = await alice.login('alice', 'AlicePass123', 'user');
  check('Employee login on user portal succeeds', al.status === 200 && al.json.redirect === '/dashboard.html');
  await bob.login('bob', 'BobPass1234', 'user');
  check('User blocked from admin reviews API -> 403', (await alice.get('/api/admin/reviews')).status === 403);
  check('User blocked from admin users API -> 403', (await alice.get('/api/admin/users')).status === 403);
  check('User cannot create reviews -> 403', (await alice.post('/api/admin/reviews', { userId: aliceId })).status === 403);
  check('Admin blocked from user review endpoint without preview -> 403', (await admin.get('/api/me/reviews')).status === 403);
  check('Admin blocked from user response endpoint -> 403', (await admin.post('/api/me/reviews/x/response', { type: 'accepted' })).status === 403);
  const pg1 = await alice.get('/admin/dashboard.html');
  check('User visiting admin dashboard page is redirected', pg1.status === 302 && pg1.headers.location === '/dashboard.html');
  const pg2 = await anon.get('/dashboard.html');
  check('Anonymous visiting user dashboard redirected to login', pg2.status === 302 && pg2.headers.location === '/login.html');
  const pg3 = await admin.get('/admin/dashboard.html');
  check('Admin dashboard served to admin', pg3.status === 200 && /Admin Portal/.test(pg3.text));
  const lp1 = await anon.get('/login.html'); const lp2 = await anon.get('/admin/login.html');
  check('Login pages contain no prefilled passwords or demo hints',
    [lp1.text, lp2.text].every((t) => !/value="[^"]+"[^>]*type="password"|type="password"[^>]*value="[^"]+"/i.test(t) && !/demo|default password|admin123|password:\s*\w+/i.test(t)));
  check('Static path traversal blocked', [400, 403, 404].includes((await anon.get('/../server.js')).status) && !(await anon.get('/%2e%2e/server.js')).text.includes('require('));
  check('Security headers present (CSP, nosniff, frame deny)', /default-src 'self'/.test(lp1.headers['content-security-policy'] || '') && lp1.headers['x-content-type-options'] === 'nosniff' && lp1.headers['x-frame-options'] === 'DENY');

  /* 4. Review creation, scoring & zero-override ---------------------------- */
  section('4. Scoring & mandatory zero-score override');
  const r1 = await admin.post('/api/admin/reviews', {
    userId: aliceId, period: '2026-10', controlId: 'C.02',
    checks: allDone({ performed_on_time: 'partial', evidences_uploaded: 'not_done' }),
    overall_comment: 'Evidence for week 3 missing.', admin_internal_notes: 'SECRET-INTERNAL-NOTE-XYZ',
    check_remarks: { evidences_uploaded: 'Upload the reconciliation sheet' }
  });
  check('Admin creates review -> 201', r1.status === 201);
  const rev1 = r1.json.review;
  check('Base score (3.5/5) = 70%', rev1.overall_quality_score === 70 && rev1.base_score === 70);
  check('No override when controls performed', rev1.score_override_applied === false);
  check('Rating band computed', rev1.rating === 'Satisfactory');
  check('Control name resolved from official catalog', rev1.controlName === 'Customer segmentation validation');
  check('Period split into year/month', rev1.year === 2026 && rev1.month === 10);
  check('Default visibility: all visible', Object.values(rev1.visibility.checks).every(Boolean) && rev1.visibility.overall_quality_score && rev1.visibility.overall_comment);
  const r2 = await admin.post('/api/admin/reviews', { userId: aliceId, period: '2026-10', controlId: 'C.05', checks: allDone({ controls_performed: 'not_done' }) });
  check('controls_performed=not_done forces 0% (others all Done)', r2.status === 201 && r2.json.review.overall_quality_score === 0);
  check('Override flag recorded with base score preserved', r2.json.review.score_override_applied === true && r2.json.review.base_score === 80);
  const rev2 = r2.json.review;
  const r3 = await admin.post('/api/admin/reviews', { userId: aliceId, period: '2026-10', controlId: 'C.55', checks: allDone(), overall_quality_score: 12 });
  check('All Done = 100%; client-supplied score ignored', r3.json.review.overall_quality_score === 100);
  const r4 = await admin.post('/api/admin/reviews', { userId: aliceId, period: '2026-09', controlId: 'C.01', checks: allDone({ controls_performed: 'partial', followup_done: 'partial' }) });
  check('Partial points: 4.0/5 = 80%', r4.json.review.overall_quality_score === 80);
  const rev4 = r4.json.review;
  const r5 = await admin.post('/api/admin/reviews', { userId: aliceId, period: '2025-12', controlId: 'C.28', checks: allDone({ controls_performed: 'not_done', performed_on_time: 'not_done', evidences_uploaded: 'not_done', followup_done: 'not_done', correct_count_entered: 'not_done' }) });
  check('All Not Done = 0%', r5.json.review.overall_quality_score === 0);
  check('Missing check rejected -> 400', (await admin.post('/api/admin/reviews', { userId: aliceId, period: '2026-08', controlId: 'C.03', checks: { controls_performed: 'done' } })).status === 400);
  check('Invalid status value rejected -> 400', (await admin.post('/api/admin/reviews', { userId: aliceId, period: '2026-08', controlId: 'C.03', checks: allDone({ followup_done: 'maybe' }) })).status === 400);
  check('Unknown control C.50 rejected -> 400', (await admin.post('/api/admin/reviews', { userId: aliceId, period: '2026-08', controlId: 'C.50', checks: allDone() })).status === 400);
  check('Retired control C.04 rejected -> 400', (await admin.post('/api/admin/reviews', { userId: aliceId, period: '2026-08', controlId: 'C.04', checks: allDone() })).status === 400);
  check('Invalid period rejected -> 400', (await admin.post('/api/admin/reviews', { userId: aliceId, period: '2026-13', controlId: 'C.03', checks: allDone() })).status === 400);
  check('Review for admin account rejected -> 400', (await admin.post('/api/admin/reviews', { userId: adminLogin.json.user.id, period: '2026-08', controlId: 'C.03', checks: allDone() })).status === 400);
  check('Duplicate employee/period/control -> 409', (await admin.post('/api/admin/reviews', { userId: aliceId, period: '2026-10', controlId: 'C.02', checks: allDone() })).status === 409);
  const up = await admin.put(`/api/admin/reviews/${rev4.id}`, { checks: { controls_performed: 'not_done' } });
  check('PUT re-applies zero override on update', up.status === 200 && up.json.review.overall_quality_score === 0 && up.json.review.score_override_applied === true);
  const up2 = await admin.put(`/api/admin/reviews/${rev4.id}`, { checks: { controls_performed: 'done' } });
  check('PUT restores computed score when override lifted (4.5/5 = 90%)', up2.json.review.overall_quality_score === 90 && up2.json.review.score_override_applied === false);
  const qarFile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'qar_entries.json'), 'utf8'));
  check('Override persisted server-side in qar_entries.json', qarFile.find((x) => x.id === rev2.id).overall_quality_score === 0);
  check('Non-boolean visibility flag rejected -> 400', (await admin.put(`/api/admin/reviews/${rev1.id}`, { visibility: { overall_comment: 'false' } })).status === 400);

  /* 5. Redaction & preview ------------------------------------------------- */
  section('5. Redaction, hidden checks & admin preview');
  await admin.put(`/api/admin/reviews/${rev1.id}`, { visibility: { checks: { evidences_uploaded: false }, overall_comment: false }, overall_comment: 'HIDDEN-COMMENT-123' });
  await admin.put(`/api/admin/reviews/${rev2.id}`, { visibility: { overall_quality_score: false } });
  const mine = await alice.get('/api/me/reviews');
  check('User lists own reviews', mine.status === 200 && mine.json.reviews.length === 5);
  check('admin_internal_notes never in user payload', !mine.text.includes('admin_internal_notes') && !mine.text.includes('SECRET-INTERNAL-NOTE-XYZ'));
  const u1 = mine.json.reviews.find((r) => r.id === rev1.id);
  check('Hidden check stripped from user payload', !('evidences_uploaded' in u1.checks) && Object.keys(u1.checks).length === 4);
  check('Remark of hidden check stripped too', !mine.text.includes('Upload the reconciliation sheet'));
  check('Hidden overall_comment stripped', !('overall_comment' in u1) && !mine.text.includes('HIDDEN-COMMENT-123'));
  check('Visible checks still delivered', u1.checks.controls_performed === 'done' && u1.checks.performed_on_time === 'partial');
  const u2 = mine.json.reviews.find((r) => r.id === rev2.id);
  check('Hidden score stripped (incl. rating & override flag)', !('overall_quality_score' in u2) && !('rating' in u2) && !('score_override_applied' in u2));
  check('Visibility config not exposed to users', !('visibility' in u1));
  check('Users only see their own reviews', (await bob.get('/api/me/reviews')).json.reviews.length === 0);
  check('User cannot respond to another user\'s review -> 404', (await bob.post(`/api/me/reviews/${rev1.id}/response`, { type: 'accepted' })).status === 404);
  const pv = await admin.get(`/api/me/reviews?preview=true&userId=${aliceId}`);
  check('Admin preview returns employee view', pv.status === 200 && pv.json.preview === true && pv.json.reviews.length === 5);
  check('Preview keeps internal notes redacted', !pv.text.includes('SECRET-INTERNAL-NOTE-XYZ') && !pv.text.includes('admin_internal_notes'));
  check('Preview identical to employee payload', JSON.stringify(pv.json.reviews) === JSON.stringify(mine.json.reviews));
  check('Preview requires a valid employee id -> 400', (await admin.get('/api/me/reviews?preview=true&userId=nope')).status === 400);
  check('User cannot use preview to view others', (await bob.get(`/api/me/reviews?preview=true&userId=${aliceId}`)).json.reviews.length === 0);
  const adm = await admin.get('/api/admin/reviews');
  check('Admin payload keeps internal notes', adm.text.includes('SECRET-INTERNAL-NOTE-XYZ'));

  /* 6. Filtering & rolling years -------------------------------------------- */
  section('6. Year / month filtering & rolling year list');
  check('User filter year=2026', (await alice.get('/api/me/reviews?year=2026')).json.reviews.length === 4);
  check('User filter year=2026&month=10', (await alice.get('/api/me/reviews?year=2026&month=10')).json.reviews.length === 3);
  check('User filter month without leading zero (month=9)', (await alice.get('/api/me/reviews?year=2026&month=9')).json.reviews.length === 1);
  check('User filter year=2025&month=12', (await alice.get('/api/me/reviews?year=2025&month=12')).json.reviews.length === 1);
  check('Empty period returns no reviews', (await alice.get('/api/me/reviews?year=2024')).json.reviews.length === 0);
  check('Admin filter year+month', (await admin.get('/api/admin/reviews?year=2026&month=10')).json.reviews.length === 3);
  check('Admin filter by control', (await admin.get('/api/admin/reviews?controlId=C.55')).json.reviews.length === 1);
  check('Invalid year rejected -> 400', (await admin.get('/api/admin/reviews?year=20x6')).status === 400);
  check('Invalid month rejected -> 400', (await alice.get('/api/me/reviews?month=13')).status === 400);
  const sorted = (await admin.get('/api/admin/reviews')).json.reviews.map((r) => r.period);
  check('Reviews sorted newest period first', JSON.stringify(sorted) === JSON.stringify([...sorted].sort().reverse()));
  const ay = (await admin.get('/api/admin/reviews')).json.availableYears;
  check('Year list is computed from the calendar (current + next year)', Array.isArray(ay) && ay.includes(CUR_YEAR) && ay.includes(NEXT_YEAR));
  check('Year list includes every year that has reviews (2025)', ay.includes(2025));
  check('Year list is continuous and newest first', ay.every((y, i) => i === 0 || ay[i - 1] - y === 1));
  const nextJan = await admin.post('/api/admin/reviews', { userId: aliceId, period: `${NEXT_YEAR}-01`, controlId: 'C.54', checks: allDone() });
  check(`Review can be issued for next year (${NEXT_YEAR}-01)`, nextJan.status === 201 && nextJan.json.review.year === NEXT_YEAR);
  check(`Next-year review visible via year=${NEXT_YEAR} filter (user)`, (await alice.get(`/api/me/reviews?year=${NEXT_YEAR}`)).json.reviews.length === 1);
  check(`Next-year review visible via year=${NEXT_YEAR}&month=01 (admin)`, (await admin.get(`/api/admin/reviews?year=${NEXT_YEAR}&month=01`)).json.reviews.length === 1);
  check('User payload also carries the rolling year list', (await alice.get('/api/me/reviews')).json.availableYears.includes(NEXT_YEAR));
  check('Period beyond next year rejected (typo guard)', (await admin.post('/api/admin/reviews', { userId: aliceId, period: `${NEXT_YEAR + 1}-01`, controlId: 'C.03', checks: allDone() })).status === 400);
  check('Period before 2020 rejected', (await admin.post('/api/admin/reviews', { userId: aliceId, period: '2019-12', controlId: 'C.03', checks: allDone() })).status === 400);

  /* 7. CSV exports --------------------------------------------------------- */
  section('7. CSV exports & sanitization');
  const ucsv = await alice.get('/api/me/reviews/export?year=2026&month=10');
  check('User CSV export -> 200 text/csv', ucsv.status === 200 && /text\/csv/.test(ucsv.headers['content-type']));
  check('User CSV served as attachment', /attachment; filename="my_qar_reviews_2026-10\.csv"/.test(ucsv.headers['content-disposition'] || ''));
  check('User CSV has header + 3 rows', ucsv.text.replace(/^\uFEFF/, '').trim().split('\r\n').length === 4);
  check('User CSV excludes internal notes', !/internal/i.test(ucsv.text) && !ucsv.text.includes('SECRET-INTERNAL-NOTE-XYZ'));
  check('User CSV excludes hidden comment', !ucsv.text.includes('HIDDEN-COMMENT-123'));
  check('User CSV marks hidden values as "Not shared"', ucsv.text.includes('Not shared'));
  const acsv = await admin.get('/api/admin/reviews/export');
  check('Admin CSV includes internal notes column & value', acsv.status === 200 && acsv.text.includes('Admin Internal Notes') && acsv.text.includes('SECRET-INTERNAL-NOTE-XYZ'));
  check('Admin CSV contains all 6 reviews', acsv.text.replace(/^\uFEFF/, '').trim().split('\r\n').length === 7);
  await admin.put(`/api/admin/reviews/${rev1.id}`, { admin_internal_notes: '=HYPERLINK("http://x")' });
  check('CSV neutralizes spreadsheet formula injection', (await admin.get('/api/admin/reviews/export')).text.includes(`'=HYPERLINK`));
  check('User cannot download admin CSV -> 403', (await alice.get('/api/admin/reviews/export')).status === 403);

  /* 8. Workflow: response -> resolution -> completion -> verification ------ */
  section('8. Change-request workflow & admin verification');
  const n0 = await alice.get('/api/me/notifications');
  check('Employee notified of issued reviews', n0.json.notifications.some((n) => n.type === 'review_issued' && n.reviewId === rev1.id));
  check('Unread notification count reported', n0.json.unread >= 5);
  check('Complete-changes before approval -> 409', (await alice.post(`/api/me/reviews/${rev1.id}/complete-changes`, { remarks: 'Too early' })).status === 409);
  check('Invalid response type -> 400', (await alice.post(`/api/me/reviews/${rev1.id}/response`, { type: 'whatever', remarks: 'x' })).status === 400);
  check('Change request without remarks -> 400', (await alice.post(`/api/me/reviews/${rev1.id}/response`, { type: 'change_requested' })).status === 400);
  const resp = await alice.post(`/api/me/reviews/${rev1.id}/response`, {
    type: 'change_requested', remarks: 'Week 3 evidence exists; will re-upload with corrected count.', evidence: 'SharePoint/QAR/C02/Oct',
    attachment: { name: 'recon.csv', type: 'text/csv', data: Buffer.from('a,b\n1,2\n').toString('base64') }
  });
  check('User submits change request -> 200', resp.status === 200);
  check('Status -> pending_admin_review, changeStatus -> change_requested', resp.json.review.status === 'pending_admin_review' && resp.json.review.changeStatus === 'change_requested');
  check('Evidence attachment stored', resp.json.review.attachments.length === 1);
  const attId = resp.json.review.attachments[0].id;
  const dl = await alice.get(`/api/evidence/${rev1.id}/${attId}`);
  check('Owner can download evidence', dl.status === 200 && dl.text === 'a,b\n1,2\n');
  check('Other users cannot download evidence -> 404', (await bob.get(`/api/evidence/${rev1.id}/${attId}`)).status === 404);
  check('Disallowed attachment type rejected', (await alice.post(`/api/me/reviews/${rev2.id}/response`, { type: 'clarification_requested', remarks: 'Why zero?', attachment: { name: 'x.exe', data: 'AAAA' } })).status === 400);
  check('Second response while pending -> 409', (await alice.post(`/api/me/reviews/${rev1.id}/response`, { type: 'accepted' })).status === 409);
  const an = await admin.get('/api/admin/notifications');
  check('Admin notified of change request', an.json.notifications.some((n) => n.type === 'user_response' && n.reviewId === rev1.id));
  const res1 = await admin.post(`/api/admin/reviews/${rev1.id}/resolve-response`, { note: 'Approved. Re-upload and correct the count.', decision: 'approved' });
  check('Admin resolves change request -> awaiting_changes', res1.status === 200 && res1.json.review.status === 'resolved' && res1.json.review.changeStatus === 'awaiting_changes');
  check('Resolution note stamped with reviewer', res1.json.review.adminResolution.note.startsWith('Approved') && res1.json.review.adminResolution.resolvedByName === 'QAR Administrator');
  check('Resolving twice -> 409', (await admin.post(`/api/admin/reviews/${rev1.id}/resolve-response`, { note: 'again' })).status === 409);
  check('Verify before completion -> 409', (await admin.post(`/api/admin/reviews/${rev1.id}/verify-changes`, {})).status === 409);
  check('User notified of resolution', (await alice.get('/api/me/notifications')).json.notifications.some((n) => n.type === 'response_resolved'));
  check('Complete-changes without remarks -> 400', (await alice.post(`/api/me/reviews/${rev1.id}/complete-changes`, {})).status === 400);
  const comp = await alice.post(`/api/me/reviews/${rev1.id}/complete-changes`, { remarks: 'Re-uploaded week 3 evidence and corrected count to 1,245.', evidence: 'SharePoint/QAR/C02/Oct/v2' });
  check('User marks changes completed', comp.status === 200 && comp.json.review.changeStatus === 'changes_completed' && !!comp.json.review.changeCompletion.completedAt);
  check('Admin notified that changes are ready', (await admin.get('/api/admin/notifications')).json.notifications.some((n) => n.type === 'changes_completed'));
  check('User cannot verify own changes -> 403', (await alice.post(`/api/admin/reviews/${rev1.id}/verify-changes`, {})).status === 403);
  const ver = await admin.post(`/api/admin/reviews/${rev1.id}/verify-changes`, { note: 'Evidence checked.' });
  check('Admin verifies changes -> changes_verified', ver.status === 200 && ver.json.review.changeStatus === 'changes_verified');
  check('changesVerifiedAt & changesVerifiedBy stamped', !!ver.json.review.changesVerifiedAt && ver.json.review.changesVerifiedBy === 'QAR Administrator');
  const afterVer = (await alice.get('/api/me/reviews')).json.reviews.find((r) => r.id === rev1.id);
  check('Employee sees verified status', afterVer.changeStatus === 'changes_verified' && afterVer.changesVerifiedBy === 'QAR Administrator');
  check('Employee notified of verification', (await alice.get('/api/me/notifications')).json.notifications.some((n) => n.type === 'changes_verified'));
  const cl = await alice.post(`/api/me/reviews/${rev2.id}/response`, { type: 'clarification_requested', remarks: 'Why is my score zero?' });
  check('Clarification request accepted', cl.status === 200 && cl.json.review.changeStatus === 'none');
  check('Clarification resolution keeps changeStatus none', (await admin.post(`/api/admin/reviews/${rev2.id}/resolve-response`, { note: 'Control not executed in October.' })).json.review.changeStatus === 'none');
  await alice.post(`/api/me/reviews/${rev4.id}/response`, { type: 'change_requested', remarks: 'Follow-up was done on 3 Sep.' });
  await admin.post(`/api/admin/reviews/${rev4.id}/resolve-response`, { note: 'OK, update it.' });
  await alice.post(`/api/me/reviews/${rev4.id}/complete-changes`, { remarks: 'Attached follow-up log.' });
  const reo = await admin.post(`/api/admin/reviews/${rev4.id}/verify-changes`, { action: 'reopen', note: 'Log not attached.' });
  check('Admin can reopen completed changes', reo.status === 200 && reo.json.review.changeStatus === 'awaiting_changes');
  check('Response on unknown review -> 404', (await bob.post('/api/me/reviews/none/response', { type: 'accepted' })).status === 404);

  /* 9. Threaded feedback --------------------------------------------------- */
  section('9. Threaded to-and-fro feedback');
  const t1 = await admin.post(`/api/reviews/${rev2.id}/reply`, { message: 'Please confirm whether the C.05 quotation check ran.' });
  check('Admin posts thread message -> 201', t1.status === 201);
  check('User notified of reviewer reply', (await alice.get('/api/me/notifications')).json.notifications.some((n) => n.type === 'thread_reply' && n.reviewId === rev2.id));
  const t2 = await alice.post(`/api/reviews/${rev2.id}/reply`, { message: 'It did not run; system outage.' });
  check('User replies in thread -> 201', t2.status === 201);
  check('Admin notified of employee reply', (await admin.get('/api/admin/notifications')).json.notifications.some((n) => n.type === 'thread_reply' && n.reviewId === rev2.id));
  await admin.post(`/api/reviews/${rev2.id}/reply`, { message: 'Noted, thanks.' });
  const thr = (await alice.get('/api/me/reviews')).json.reviews.find((r) => r.id === rev2.id).feedbackThread;
  check('Thread holds 3 messages in order', thr.length === 3 && thr[0].authorRole === 'admin' && thr[1].authorRole === 'user' && thr[2].message === 'Noted, thanks.');
  check('Thread messages expose no internal ids', !('authorId' in thr[0]));
  check('Other user cannot post on thread -> 404', (await bob.post(`/api/reviews/${rev2.id}/reply`, { message: 'hi' })).status === 404);
  check('Empty thread message rejected -> 400', (await alice.post(`/api/reviews/${rev2.id}/reply`, { message: '   ' })).status === 400);

  /* 10. Notifications, user mgmt, delete, rate limit, logout -------------- */
  section('10. Notifications, administration, rate limiting & logout');
  const nl = await alice.get('/api/me/notifications');
  const first = nl.json.notifications[0];
  check('Mark one notification read', (await alice.post(`/api/me/notifications/${first.id}/read`)).status === 200);
  check('Cannot mark another user\'s notification', (await bob.post(`/api/me/notifications/${first.id}/read`)).status === 404);
  await alice.post('/api/me/notifications/read-all');
  check('Mark all read -> unread = 0', (await alice.get('/api/me/notifications')).json.unread === 0);
  check('notifications.json persisted', JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'notifications.json'), 'utf8')).length > 10);
  const dis = await admin.put(`/api/admin/users/${bobId}`, { active: false });
  check('Admin disables user', dis.status === 200 && dis.json.user.active === false);
  check('Disabled user\'s session is revoked', (await bob.get('/api/me')).status === 401);
  check('Admin cannot delete own account', (await admin.del(`/api/admin/users/${adminLogin.json.user.id}`)).status === 400);
  check('Delete user with reviews requires cascade -> 409', (await admin.del(`/api/admin/users/${aliceId}`)).status === 409);
  const delRev = await admin.del(`/api/admin/reviews/${r5.json.review.id}`);
  check('Admin deletes a review', delRev.status === 200 && (await admin.get('/api/admin/reviews')).json.reviews.length === 5);
  check('Deleted review gone for user -> 404 on response', (await alice.post(`/api/me/reviews/${r5.json.review.id}/response`, { type: 'accepted' })).status === 404);
  const rlClient = new Client('192.168.77.7');
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await rlClient.login('alice', 'wrong-password-1', 'user')).status);
  check('5 attempts allowed per minute per IP', statuses.slice(0, 5).every((s) => s === 401));
  check('6th attempt -> 429 with Retry-After', statuses[5] === 429);
  check('Rate limit is per IP (other IP unaffected)', (await new Client('192.168.77.8').login('alice', 'AlicePass123', 'user')).status === 200);
  const pw = await alice.post('/api/me/password', { currentPassword: 'AlicePass123', newPassword: 'AliceNewPass456' });
  check('User changes own password', pw.status === 200 && (await new Client().login('alice', 'AliceNewPass456', 'user')).status === 200);
  const lo = await alice.post('/api/logout');
  check('Logout clears cookies', lo.status === 200 && !alice.cookies.session);
  check('Session invalid after logout', (await alice.get('/api/me/reviews')).status === 401);

  await Promise.all(Array.from({ length: 15 }, (_, i) => admin.post(`/api/reviews/${rev1.id}/reply`, { message: `parallel ${i}` })));
  await sleep(200);
  const finalFile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'qar_entries.json'), 'utf8'));
  check('Parallel writes serialized — file valid & complete', finalFile.find((x) => x.id === rev1.id).feedbackThread.filter((m) => m.message.startsWith('parallel')).length === 15);

  /* 11. v1.2 hardening -------------------------------------------------------- */
  section('11. v1.2 hardening — email sign-in, lockout, admin recovery, assets');
  const h2 = await anon.get('/api/health');
  check('Health reports application version 1.2.0', h2.json.version === '1.2.0');
  check('Cross-Origin-Opener-Policy header set', h2.headers['cross-origin-opener-policy'] === 'same-origin');
  check('Cross-Origin-Resource-Policy header set', h2.headers['cross-origin-resource-policy'] === 'same-origin');
  const byEmail = await new Client().login('Alice@NWC.example', 'AliceNewPass456', 'user');
  check('Sign-in with email address (case-insensitive)', byEmail.status === 200 && byEmail.json.user.username === 'alice');
  check('Duplicate email rejected -> 409', (await admin.post('/api/admin/users', { username: 'alice2', fullName: 'Alice Two', email: 'alice@nwc.example', password: 'AliceTwo1234' })).status === 409);
  const cc = await admin.post('/api/admin/users', { username: 'carol', fullName: 'Carol Employee', email: 'carol@nwc.example', password: 'CarolPass123', role: 'user' });
  check('Third employee created', cc.status === 201);
  const ok8 = [];
  const officeNat = new Client('172.16.5.5');
  for (let i = 0; i < 8; i++) ok8.push((await officeNat.login('carol', 'CarolPass123', 'user')).status);
  check('Successful sign-ins are not throttled (shared office IP)', ok8.every((x) => x === 200));
  const spread = [];
  for (let i = 0; i < 10; i++) spread.push((await new Client(`10.99.0.${i + 1}`).login('carol', `wrong-guess-${i}`, 'user')).status);
  check('10 failures for one account from 10 IPs are each 401', spread.every((x) => x === 401));
  const locked = await new Client('10.99.1.1').login('carol', 'CarolPass123', 'user');
  check('Account locked after 10 failures (any IP) -> 429', locked.status === 429 && !!locked.headers['retry-after']);
  check('Lockout is per account (other users unaffected)', (await new Client('10.99.1.2').login('alice', 'AliceNewPass456', 'user')).status === 200);
  const logo = await anon.get('/img/logo.svg');
  check('Brand logo served as SVG', logo.status === 200 && /image\/svg\+xml/.test(logo.headers['content-type'] || ''));
  check('robots.txt disallows indexing', /Disallow: \//.test((await anon.get('/robots.txt')).text));
  const lp = await anon.get('/login.html');
  check('Login page has no inline scripts (strict CSP)', !/<script>(?!\s*<\/script>)/i.test(lp.text) && !/\son[a-z]+="/i.test(lp.text));

  // Admin recovery through the hosting environment (ADMIN_PASSWORD) after a restart
  await haltServer();
  await startServer({ ADMIN_PASSWORD: 'RecoveredPass2026', ADMIN_EMAIL: 'qa.admin@nwc.example' }, true);
  check('Old admin password rejected after env change', (await new Client().login(ADMIN_USER, ADMIN_PASS, 'admin')).status === 401);
  const rec = await new Client().login(ADMIN_USER, 'RecoveredPass2026', 'admin');
  check('Admin password re-synchronised from ADMIN_PASSWORD on restart', rec.status === 200 && rec.json.user.mustChangePassword === false);
  check('ADMIN_EMAIL applied and usable for sign-in', (await new Client().login('qa.admin@nwc.example', 'RecoveredPass2026', 'admin')).status === 200);
  check('Existing sessions revoked after admin password reset', (await admin.get('/api/me')).status === 401);
  check('Data preserved across restart', JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8')).some((u) => u.username === 'carol'));
  check('Server refuses to start with a weak ADMIN_PASSWORD', (await expectBootFailure({ ADMIN_PASSWORD: 'short' })) === 1);
  check('Server refuses to start with an invalid ADMIN_USERNAME', (await expectBootFailure({ ADMIN_USERNAME: 'a b', ADMIN_PASSWORD: 'ValidPass123' })) === 1);
}

/* ---------------------------------------------------------------------------
 * Runner — writes a machine-readable report used by the release gate
 * ------------------------------------------------------------------------- */
(async () => {
  console.log('QAR verification suite (isolated test environment)');
  console.log('==================================================');
  const started = Date.now();
  try {
    await run();
  } catch (err) {
    failed++; failures.push(`Suite crashed: ${err.message}`);
    console.error(err);
  } finally {
    await stopServer();
  }
  const total = passed + failed;
  const ok = failed === 0 && total >= MIN_CHECKS;
  console.log('\n----------------------------------------------');
  console.log(` Checks run: ${total} (minimum required ${MIN_CHECKS})`);
  console.log(` Passed    : ${passed}`);
  console.log(` Failed    : ${failed}`);
  if (failures.length) console.log(` Failures  :\n   - ${failures.join('\n   - ')}`);
  console.log(` Result    : ${ok ? 'PASS — release approved' : 'FAIL — release blocked'}`);
  console.log('----------------------------------------------');
  if (process.env.QAR_TEST_REPORT) {
    try {
      fs.writeFileSync(process.env.QAR_TEST_REPORT, JSON.stringify({
        result: ok ? 'pass' : 'fail', total, passed, failed, failures,
        node: process.version, finishedAt: new Date().toISOString(), durationMs: Date.now() - started
      }, null, 2));
    } catch (e) { console.error('Could not write test report:', e.message); }
  }
  process.exit(ok ? 0 : 1);
})();
