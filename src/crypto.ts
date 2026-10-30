import { createHash, randomBytes } from 'node:crypto';

/**
 * Computes a 32-byte SHA-256 preimage commitment hash for AnchorWire structured authentication.
 *
 * @param preimage - The secret validator bytes or string.
 * @returns 32-byte Buffer containing the SHA-256 digest commitment.
 */
export function computeCommitment(preimage: Uint8Array | Buffer | string): Buffer {
  const hash = createHash('sha256');
  if (typeof preimage === 'string') {
    hash.update(preimage, 'utf8');
  } else {
    hash.update(preimage);
  }
  return hash.digest();
}

/**
 * Generates a fresh cryptographically secure 32-byte validator preimage and its corresponding SHA-256 commitment.
 *
 * @returns Pair of { validator: Buffer, commitment: Buffer }
 */
export function generateCommitmentPair(): { validator: Buffer; commitment: Buffer } {
  const validator = randomBytes(32);
  const commitment = computeCommitment(validator);
  return { validator, commitment };
}
