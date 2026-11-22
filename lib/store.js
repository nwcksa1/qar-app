'use strict';
/**
 * Atomic JSON flat-file store with an in-process serialized write queue.
 *
 *  - Data is held in memory; mutations run synchronously inside update(),
 *    so (single-threaded) state can never interleave.
 *  - A snapshot is taken at mutation time and persisted through a promise
 *    chain, so writes hit the disk strictly in order, never concurrently.
 *  - Each write goes to a unique temp file, is fsync'ed, then renamed over
 *    the target (atomic on POSIX and NTFS) — a crash never leaves a half file.
 */
const fs = require('fs');
const path = require('path');

let tmpCounter = 0;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function writeAtomic(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${++tmpCounter}.tmp`;
  const fh = await fs.promises.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  // Windows can transiently lock files (AV scanners / indexers) -> retry rename.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmp, filePath);
      return;
    } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        await fs.promises.unlink(tmp).catch(() => {});
        throw err;
      }
      await sleep(25 * (attempt + 1));
    }
  }
}

class JsonStore {
  /**
   * @param {string} filePath     absolute path of the JSON file
   * @param {*}      defaultValue value used when the file does not exist
   */
  constructor(filePath, defaultValue) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
    this.data = this._load(defaultValue);
  }

  _load(defaultValue) {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Corrupt file: keep a forensic copy, then start clean.
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        try { fs.copyFileSync(this.filePath, backup); } catch (_) { /* ignore */ }
        console.error(`[store] ${path.basename(this.filePath)} unreadable (${err.message}); backup saved to ${backup}`);
      }
      const fresh = JSON.parse(JSON.stringify(defaultValue));
      fs.writeFileSync(this.filePath, JSON.stringify(fresh, null, 2), { mode: 0o600 });
      return fresh;
    }
  }

  /** Read-only access to the in-memory data. Never mutate outside update(). */
  get() { return this.data; }

  /**
   * Run a synchronous mutator against the data and persist it.
   * Resolves with the mutator's return value once the write is on disk.
   */
  update(mutator) {
    const result = mutator(this.data);
    const snapshot = JSON.stringify(this.data, null, 2);
    const write = this.queue.then(() => writeAtomic(this.filePath, snapshot));
    this.queue = write.catch((err) => console.error(`[store] write failed for ${this.filePath}:`, err));
    return write.then(() => result);
  }

  /** Wait for all queued writes (used on shutdown). */
  flush() { return this.queue; }
}

module.exports = { JsonStore, writeAtomic };
