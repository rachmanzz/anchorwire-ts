/**
 * Standard IEEE 802.3 CRC32 calculation matching Go's hash/crc32.ChecksumIEEE.
 */
const CRC_TABLE = new Uint32Array(256);

// Pre-compute lookup table
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

/**
 * Calculates 32-bit CRC checksum using the IEEE polynomial (0xEDB88320).
 *
 * @param buf The input buffer (Uint8Array or Buffer)
 * @returns 32-bit unsigned integer checksum
 */
export function crc32IEEE(buf: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
