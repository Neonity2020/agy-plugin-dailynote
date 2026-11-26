import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createTempDataDir(prefix = 'dn-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Valid minimal PNG (1x1 transparent pixel)
export const SAMPLE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

// Minimal JPEG header bytes (> 12 bytes)
export const SAMPLE_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

// Minimal GIF89a header (> 12 bytes)
export const SAMPLE_GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!', 'binary');

// Minimal RIFF WEBP header (> 12 bytes)
export const SAMPLE_WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x14, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from('VP8 '),
  Buffer.from([0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
]);

export const SAMPLE_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
