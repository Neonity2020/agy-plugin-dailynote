import { DatabaseSync } from 'node:sqlite';

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function isBusyError(err) {
  if (!err) return false;
  const code = String(err.errcode ?? err.code ?? '');
  const msg = String(err.message ?? '').toLowerCase();
  return code === '5' || code === 'SQLITE_BUSY' || msg.includes('database is locked') || msg.includes('busy');
}

/**
 * Thin wrapper around Node.js built-in node:sqlite DatabaseSync
 * enforcing WAL mode, foreign keys, busy_timeout, and BEGIN IMMEDIATE write transactions.
 */
export class StorageAdapter {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this._closed = false;
    this._txDepth = 0;
    this._savepointSeq = 0;

    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA temp_store = MEMORY;');
  }

  isOpen() {
    return !this._closed;
  }

  getPragma(name) {
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      throw new Error(`Invalid PRAGMA name: ${name}`);
    }
    const row = this.db.prepare(`PRAGMA ${name};`).get();
    if (!row) return undefined;
    const keys = Object.keys(row);
    return keys.length ? row[keys[0]] : undefined;
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  /**
   * Execute fn inside a BEGIN IMMEDIATE transaction (with nested SAVEPOINT support).
   */
  transaction(fn) {
    if (this._txDepth > 0) {
      const spName = `sp_${++this._savepointSeq}`;
      this.db.exec(`SAVEPOINT ${spName};`);
      this._txDepth += 1;
      try {
        const result = fn(this);
        this.db.exec(`RELEASE SAVEPOINT ${spName};`);
        return result;
      } catch (err) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${spName};`);
          this.db.exec(`RELEASE SAVEPOINT ${spName};`);
        } catch {
          // Ignore rollback failure if outer transaction already aborted
        }
        throw err;
      } finally {
        this._txDepth -= 1;
      }
    }

    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        this.db.exec('BEGIN IMMEDIATE;');
        break;
      } catch (err) {
        if (isBusyError(err) && attempt < maxAttempts - 1) {
          sleepSync(10 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }

    this._txDepth = 1;
    try {
      const result = fn(this);
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback error if connection is no longer in transaction
      }
      throw err;
    } finally {
      this._txDepth = 0;
    }
  }

  close() {
    if (!this._closed) {
      this.db.close();
      this._closed = true;
    }
  }
}
