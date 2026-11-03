/**
 * The link broker's cryptography (YA-33), all from `node:crypto`: random values, PKCE (RFC 7636, S256 only),
 * constant-time comparison, and sealing a stored record under a key derived from the one-time value that names it.
 *
 * Sealing. Every record in the link table is keyed by an id derived from a random value that only the flow holds (a
 * `state` or a one-time code), and its payload is encrypted with AES-256-GCM under a second key derived from the same
 * value. Someone who can read the table therefore learns neither the tokens nor the codes that would redeem them: the
 * value itself is never stored, and both derivations are one-way (HKDF-SHA256 with distinct `info` labels).
 */
import {createCipheriv, createDecipheriv, createHash, hkdfSync, timingSafeEqual} from 'node:crypto';

/** A source of cryptographically random bytes; `crypto.randomBytes` in production, a counter in tests. */
export type RandomBytes = (size: number) => Uint8Array;

/** 32 random bytes: 256 bits for states, codes and PKCE verifiers, above RFC 6749's 128-bit floor. */
export const RANDOM_BYTES = 32;

/** RFC 7636 section 4.1: 43 to 128 characters from the unreserved set. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/** An S256 challenge is the base64url SHA-256 digest: exactly 43 characters. */
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

const SALT = Buffer.from('youtrack-voice-link-broker/YA-33', 'utf8');

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** A fresh random value for a state, a code or a verifier: 43 base64url characters. */
export function randomToken(random: RandomBytes): string {
  const bytes = random(RANDOM_BYTES);
  if (bytes.length !== RANDOM_BYTES) throw new Error('random source returned the wrong number of bytes');
  return base64Url(bytes);
}

export function isPkceVerifier(value: string): boolean {
  return VERIFIER.test(value);
}

export function isS256Challenge(value: string): boolean {
  return CHALLENGE.test(value);
}

/** RFC 7636 section 4.2: BASE64URL(SHA256(ASCII(code_verifier))). */
export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * Compares two strings without an early exit on the first differing byte, and without revealing the expected length:
 * both sides are hashed to 32 bytes first, then compared with `timingSafeEqual`.
 */
export function constantTimeEqual(actual: string, expected: string): boolean {
  const a = createHash('sha256').update(actual, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b) && actual.length === expected.length;
}

/** What a record id or key is derived for. Distinct labels keep the id from ever being usable as the key. */
type Purpose = 'id' | 'key';

function derive(secret: string, purpose: Purpose, kind: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), SALT, `${kind}:${purpose}`, 32));
}

/** The table key for a record named by `secret`, as hex. `kind` separates states from codes. */
export function recordId(kind: string, secret: string): string {
  return `${kind}#${derive(secret, 'id', kind).toString('hex')}`;
}

/** A short, non-reversible tag for log lines, so one flow's lines can be followed without carrying its value. */
export function flowTag(kind: string, secret: string): string {
  return derive(secret, 'id', kind).toString('hex').slice(0, 12);
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

/** Encrypts `plaintext` under the key derived from `secret`. The output is `v1.<base64url(iv | ciphertext | tag)>`. */
export function seal(kind: string, secret: string, plaintext: string, random: RandomBytes): string {
  const iv = Buffer.from(random(IV_BYTES));
  if (iv.length !== IV_BYTES) throw new Error('random source returned the wrong number of bytes');
  const cipher = createCipheriv('aes-256-gcm', derive(secret, 'key', kind), iv);
  cipher.setAAD(Buffer.from(`${VERSION}:${kind}`, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
}

/** Decrypts what `seal` produced for the same kind and secret. Returns null for anything that does not verify. */
export function open(kind: string, secret: string, sealed: string): string | null {
  if (!sealed.startsWith(`${VERSION}.`)) return null;
  const raw = Buffer.from(sealed.slice(VERSION.length + 1), 'base64url');
  if (raw.length < IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', derive(secret, 'key', kind), raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(`${VERSION}:${kind}`, 'utf8'));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    return null;
  }
}
