/**
 * StorageAdapter —— 对 node:sqlite（DatabaseSync）的最小抽象。
 *
 * 存在意义：keep the SQL surface 稳定（docs/ARCHITECTURE.md 第 3.2 节），一旦需要降级为
 * better-sqlite3，只需替换本文件实现，上层 notes-service 无需改动。
 *
 * 每次连接都重新执行 docs/DATA_MODEL.md 第 2 节的全部 5 条 PRAGMA。
 */

export const MIN_NODE_VERSION = '22.5.0';

/** 与 docs/DATA_MODEL.md 第 2 节逐条对应，顺序不可调整。 */
export const CONNECTION_PRAGMAS = Object.freeze([
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA temp_store = MEMORY',
]);

function parseVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

/**
 * @param {string} [version]
 * @returns {boolean}
 */
export function isNodeVersionSupported(version = process.versions.node) {
  const [actualMajor, actualMinor, actualPatch] = parseVersion(version);
  const [needMajor, needMinor, needPatch] = parseVersion(MIN_NODE_VERSION);
  if (actualMajor !== needMajor) return actualMajor > needMajor;
  if (actualMinor !== needMinor) return actualMinor > needMinor;
  return actualPatch >= needPatch;
}

/**
 * @param {string} [version]
 */
export function assertNodeVersion(version = process.versions.node) {
  if (isNodeVersionSupported(version)) return;
  const error = new Error(
    `Daily Notes 需要 Node.js >= ${MIN_NODE_VERSION}（内置 node:sqlite），当前为 ${version}。`,
  );
  error.code = 'UNSUPPORTED_NODE_VERSION';
  throw error;
}

function flattenParams(params) {
  // run('...', [a, b]) 与 run('...', a, b) 等价
  return params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
}

export class StorageAdapter {
  /** @type {import('node:sqlite').DatabaseSync | null} */
  #db = null;
  #txDepth = 0;

  /**
   * @param {string} filePath 数据库文件路径，或 ':memory:'
   */
  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath === '') {
      throw new TypeError('StorageAdapter 需要数据库文件路径');
    }
    this.filePath = filePath;
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.#db !== null;
  }

  /** @returns {import('node:sqlite').DatabaseSync} */
  get handle() {
    if (!this.#db) throw new Error('数据库连接尚未打开（先调用 open()）');
    return this.#db;
  }

  /**
   * 建立连接并应用全部 PRAGMA。
   *
   * @returns {Promise<StorageAdapter>}
   */
  async open() {
    if (this.#db) return this;
    assertNodeVersion();

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(this.filePath);
    this.#db = db;

    try {
      for (const pragma of CONNECTION_PRAGMAS) db.exec(pragma);
      // 显式触发一次读，确保连接可用（损坏文件在此处尽早暴露）
      db.prepare('SELECT 1 AS ok').get();
    } catch (error) {
      this.close();
      throw error;
    }

    return this;
  }

  close() {
    if (!this.#db) return;
    const db = this.#db;
    this.#db = null;
    try {
      db.close();
    } catch {
      /* 已关闭的连接忽略 */
    }
  }

  /**
   * @param {string} sql
   */
  exec(sql) {
    this.handle.exec(sql);
  }

  /**
   * @param {string} sql
   */
  prepare(sql) {
    return this.handle.prepare(sql);
  }

  /**
   * @param {string} sql
   * @param {...unknown} params
   * @returns {Record<string, unknown> | undefined}
   */
  get(sql, ...params) {
    return this.prepare(sql).get(...flattenParams(params));
  }

  /**
   * @param {string} sql
   * @param {...unknown} params
   * @returns {Record<string, unknown>[]}
   */
  all(sql, ...params) {
    return this.prepare(sql).all(...flattenParams(params));
  }

  /**
   * @param {string} sql
   * @param {...unknown} params
   * @returns {import('node:sqlite').StatementResultingChanges}
   */
  run(sql, ...params) {
    return this.prepare(sql).run(...flattenParams(params));
  }

  /**
   * BEGIN IMMEDIATE 写事务（提前取写锁，避免 WAL 下的升级死锁）。
   * 支持嵌套调用（内层用 SAVEPOINT）。
   *
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction 需要回调函数');

    const depth = this.#txDepth;
    const savepoint = `sp_${depth}`;
    if (depth === 0) this.exec('BEGIN IMMEDIATE');
    else this.exec(`SAVEPOINT ${savepoint}`);

    this.#txDepth = depth + 1;
    try {
      const result = fn();
      if (depth === 0) this.exec('COMMIT');
      else this.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try {
        if (depth === 0) this.exec('ROLLBACK');
        else this.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        /* 回滚失败不掩盖原始错误 */
      }
      throw error;
    } finally {
      this.#txDepth = depth;
    }
  }

  /**
   * 读取当前连接的 PRAGMA 值，供健康检查与测试断言。
   *
   * @returns {Record<string, unknown>}
   */
  readPragmas() {
    const read = (pragma, column) => {
      try {
        return this.get(`PRAGMA ${pragma}`)?.[column];
      } catch {
        return undefined;
      }
    };
    return {
      journal_mode: read('journal_mode', 'journal_mode'),
      synchronous: read('synchronous', 'synchronous'),
      foreign_keys: read('foreign_keys', 'foreign_keys'),
      busy_timeout: read('busy_timeout', 'timeout'),
      temp_store: read('temp_store', 'temp_store'),
    };
  }
}

/**
 * 建立并打开适配器。
 *
 * @param {string} filePath
 * @returns {Promise<StorageAdapter>}
 */
export async function createAdapter(filePath) {
  const adapter = new StorageAdapter(filePath);
  await adapter.open();
  return adapter;
}
