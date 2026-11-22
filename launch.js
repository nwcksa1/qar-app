#!/usr/bin/env node
'use strict';
/**
 * ============================================================================
 *  NWC QAR — Release gate launcher  (TEST  ➜  PRODUCTION)
 * ----------------------------------------------------------------------------
 *  1. Runs the full automated test suite (test.js) in an ISOLATED test
 *     environment: its own temporary data folder and its own port. Production
 *     data in ./data is never read or modified by the tests.
 *  2. ONLY if every check passes, the production server (server.js) is started
 *     on PORT (default 3000) with NODE_ENV=production.
 *  3. If any check fails, production is NOT started and the exit code is 1.
 *
 *  Every run is recorded in ./logs:
 *     logs/last-test-report.json   result of the latest test run
 *     logs/release-history.log     one line per release attempt (PASS/FAIL)
 *
 *  Usage:  node launch.js          (used by start.bat / start.sh / npm start)
 * ============================================================================
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, 'logs');
const REPORT = path.join(LOG_DIR, 'last-test-report.json');
const HISTORY = path.join(LOG_DIR, 'release-history.log');
fs.mkdirSync(LOG_DIR, { recursive: true });

function banner(lines) {
  console.log('\n  ==============================================================');
  lines.forEach((l) => console.log(`   ${l}`));
  console.log('  ==============================================================\n');
}
function history(line) {
  try { fs.appendFileSync(HISTORY, `${new Date().toISOString()}  ${line}\n`); } catch (_) { /* ignore */ }
}

function runTests() {
  return new Promise((resolve) => {
    // Test environment: never inherit production DATA_DIR / PORT.
    const env = { ...process.env, NODE_ENV: 'test', QAR_TEST_REPORT: REPORT };
    delete env.DATA_DIR; delete env.PORT;
    try { fs.unlinkSync(REPORT); } catch (_) { /* none */ }
    const child = spawn(process.execPath, [path.join(ROOT, 'test.js')], { env, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function startProduction() {
  const env = { ...process.env, NODE_ENV: 'production' };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'inherit' });
  const forward = (sig) => { try { child.kill(sig); } catch (_) { /* ignore */ } };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', (code) => process.exit(code === null ? 0 : code));
}

(async () => {
  banner(['STEP 1 of 2 — TEST ENVIRONMENT', 'Running automated verification checks (isolated data & port)…']);
  const ok = await runTests();
  let report = {};
  try { report = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch (_) { /* missing */ }
  const summary = `${report.passed ?? '?'}/${report.total ?? '?'} checks passed`;

  if (!ok || report.result !== 'pass') {
    history(`FAIL  ${summary}  -> production NOT started`);
    banner([
      '✗ TEST ENVIRONMENT FAILED — PRODUCTION NOT STARTED',
      summary,
      `Details: ${path.relative(ROOT, REPORT)}`,
      'Fix the failing checks above and run the launcher again.'
    ]);
    process.exit(1);
  }

  history(`PASS  ${summary}  -> production started`);
  banner(['✓ ALL TEST CHECKS PASSED — ' + summary, 'STEP 2 of 2 — STARTING PRODUCTION SERVER…']);
  startProduction();
})();
