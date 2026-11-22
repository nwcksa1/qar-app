'use strict';
/**
 * Security primitives: scrypt password hashing, HMAC-signed cookie values,
 * random tokens, constant-time comparison and an in-memory rate limiter.
 */
const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Hash a password with a unique 16-byte salt. Never store plaintext. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

/** Constant-time password verification. */
function verifyPassword(password, saltHex, hashHex) {
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, SCRYPT_OPTS);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

/** Pre-computed dummy credential so unknown usernames cost the same CPU time. */
const DUMMY = hashPassword(crypto.randomBytes(16).toString('hex'));
function burnPasswordCheck(password) { verifyPassword(password, DUMMY.salt, DUMMY.hash); }

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a); const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function hmac(value, secret) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }

/** "<value>.<HMAC-SHA256 signature>" */
function signValue(value, secret) { return `${value}.${hmac(value, secret)}`; }

/** Returns the original value if the signature is valid, otherwise null. */
function unsignValue(signed, secret) {
  if (typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  return safeEqual(signed.slice(i + 1), hmac(value, secret)) ? value : null;
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

/** Sliding-window limiter: max `max` hits per `windowMs` per key. */
class RateLimiter {
  constructor(max, windowMs) {
    this.max = max; this.windowMs = windowMs; this.hits = new Map();
    const t = setInterval(() => this.prune(), windowMs); t.unref();
  }
  hit(key) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((this.windowMs - (now - list[0])) / 1000)) };
    }
    list.push(now); this.hits.set(key, list);
    return { allowed: true, remaining: this.max - list.length };
  }
  /** Seconds until the key may try again (0 = not blocked). Does not record a hit. */
  blocked(key) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((this.windowMs - (now - list[0])) / 1000));
  }
  reset(key) { this.hits.delete(key); }
  prune() {
    const now = Date.now();
    for (const [k, list] of this.hits) {
      const fresh = list.filter((t) => now - t < this.windowMs);
      if (fresh.length) this.hits.set(k, fresh); else this.hits.delete(k);
    }
  }
}

module.exports = { hashPassword, verifyPassword, burnPasswordCheck, randomToken, safeEqual, signValue, unsignValue, sha256, RateLimiter };
