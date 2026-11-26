import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openService } from '../../core/index.mjs';

/**
 * 建临时数据目录 + 服务实例；测试结束自动清理。
 *
 * @param {import('node:test').TestContext} t
 * @param {{ now?: () => Date }} [options]
 */
export async function setupService(t, options = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'daily-notes-'));
  const resources = { dataDir, service: null, adapter: null };

  t.after(() => {
    try {
      resources.adapter?.close();
    } catch {
      /* ignore */
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  const opened = await openService({ dataDir, now: options.now });
  resources.service = opened.service;
  resources.adapter = opened.adapter;
  return resources;
}

/** @param {import('node:test').TestContext} t */
export function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'daily-notes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 最小合法 PNG（签名 + 少量填充字节）。
 *
 * @param {number} [size]
 * @returns {Buffer}
 */
export function pngBytes(size = 64) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length), 0x00)]);
}

/** @returns {Buffer} */
export function jpegBytes() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
}

/** @returns {Buffer} */
export function gifBytes() {
  return Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1');
}

/** @returns {Buffer} */
export function webpBytes() {
  const buffer = Buffer.alloc(24);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(16, 4);
  buffer.write('WEBP', 8, 'latin1');
  return buffer;
}

/** @param {string} filePath */
export function fileSize(filePath) {
  return statSync(filePath).size;
}
