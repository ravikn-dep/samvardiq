import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto';

import { CredentialInvalidError, KeyUnavailableError } from './errors.js';
import type { MasterKeyRing } from './keyRing.js';

/**
 * ARCH-020 envelope encryption, using only `node:crypto`:
 *
 *   data key  = 32 random bytes, fresh per credential
 *   payload   = AES-256-GCM(data key, fresh 96-bit nonce, AAD_payload)(secret)
 *   wrapped   = AES-256-GCM(master key[version], fresh 96-bit nonce, AAD_wrap)(data key)
 *
 * Both layers use a 128-bit tag, always verified (`authTagLength` pinned so a
 * truncated tag is rejected, not accepted). The AAD binds organization,
 * provider, credential ID and credential type on both layers, and the
 * master-key version on the wrap layer — the only layer that version
 * governs, so rotation re-wraps the data key without touching the payload.
 *
 * `keyCheck` (HMAC-SHA256 of a fixed label under the master key, first 16
 * bytes) is a standard key check value: it tells "the configured key for this
 * version is not the key that wrapped this row" (an operator misconfiguration
 * → key_unavailable) apart from "this row was altered" (→ credential_invalid).
 * It reveals nothing about the key.
 */
export const ENVELOPE_ALGORITHM = 'AES-256-GCM';
const CIPHER = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_CHECK_BYTES = 16;
export const MAX_SECRET_BYTES = 16_384;
const AAD_LABEL = 'samvardiq.provider-credential.v1';

export interface CredentialBinding {
  organizationId: string;
  provider: string;
  credentialId: string;
  credentialType: string;
}

export interface WrappedDataKey {
  wrappedKey: Buffer;
  wrapNonce: Buffer;
  wrapTag: Buffer;
  keyVersion: number;
  keyCheck: Buffer;
}

export interface CredentialEnvelope extends WrappedDataKey {
  ciphertext: Buffer;
  payloadNonce: Buffer;
  payloadTag: Buffer;
}

/**
 * Canonical associated data: a JSON array in fixed order. JSON string encoding
 * quotes and escapes every element, so no two distinct bindings serialize
 * alike (["A","BC"] ≠ ["AB","C"]) — unlike delimiter concatenation.
 */
export function associatedData(layer: 'payload' | 'data-key', binding: CredentialBinding, keyVersion?: number): Buffer {
  const fields: (string | number)[] = [AAD_LABEL, layer, binding.organizationId, binding.provider, binding.credentialId, binding.credentialType];
  if (layer === 'data-key') fields.push(keyVersion!);
  return Buffer.from(JSON.stringify(fields), 'utf8');
}

function keyCheck(key: KeyObject): Buffer {
  return createHmac('sha256', key).update(`${AAD_LABEL}.key-check`).digest().subarray(0, KEY_CHECK_BYTES);
}

function gcmEncrypt(key: KeyObject | Buffer, plaintext: Uint8Array, aad: Buffer): { ciphertext: Buffer; nonce: Buffer; tag: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

function gcmDecrypt(key: KeyObject | Buffer, ciphertext: Buffer, nonce: Buffer, tag: Buffer, aad: Buffer): Buffer {
  try {
    const decipher = createDecipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    decipher.setAAD(aad);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new CredentialInvalidError();
  }
}

function wrap(keyRing: MasterKeyRing, binding: CredentialBinding, dataKey: Buffer): WrappedDataKey {
  const keyVersion = keyRing.activeVersion;
  const master = keyRing.key(keyVersion);
  const { ciphertext, nonce, tag } = gcmEncrypt(master, dataKey, associatedData('data-key', binding, keyVersion));
  return { wrappedKey: ciphertext, wrapNonce: nonce, wrapTag: tag, keyVersion, keyCheck: keyCheck(master) };
}

function unwrap(keyRing: MasterKeyRing, binding: CredentialBinding, wrapped: WrappedDataKey): Buffer {
  if (!Number.isSafeInteger(wrapped.keyVersion) || wrapped.keyVersion < 1) throw new CredentialInvalidError();
  const master = keyRing.key(wrapped.keyVersion);
  if (wrapped.keyCheck.length !== KEY_CHECK_BYTES || !timingSafeEqual(wrapped.keyCheck, keyCheck(master))) throw new KeyUnavailableError();
  if (wrapped.wrappedKey.length !== KEY_BYTES || wrapped.wrapNonce.length !== NONCE_BYTES || wrapped.wrapTag.length !== TAG_BYTES) {
    throw new CredentialInvalidError();
  }
  const dataKey = gcmDecrypt(master, wrapped.wrappedKey, wrapped.wrapNonce, wrapped.wrapTag, associatedData('data-key', binding, wrapped.keyVersion));
  if (dataKey.length !== KEY_BYTES) throw new CredentialInvalidError();
  return dataKey;
}

/** Encrypts a secret under a fresh data key, wrapped by the active master key. */
export function sealCredential(keyRing: MasterKeyRing, binding: CredentialBinding, secret: Uint8Array): CredentialEnvelope {
  const dataKey = randomBytes(KEY_BYTES);
  try {
    const { ciphertext, nonce, tag } = gcmEncrypt(dataKey, secret, associatedData('payload', binding));
    return { ciphertext, payloadNonce: nonce, payloadTag: tag, ...wrap(keyRing, binding, dataKey) };
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Authenticates and decrypts. Throws KeyUnavailableError (version not held /
 * wrong key configured for it) or CredentialInvalidError (altered, transplanted
 * or malformed). The caller owns the returned buffer and must zero it.
 */
export function openCredential(keyRing: MasterKeyRing, binding: CredentialBinding, envelope: CredentialEnvelope): Buffer {
  const dataKey = unwrap(keyRing, binding, envelope);
  try {
    if (envelope.payloadNonce.length !== NONCE_BYTES || envelope.payloadTag.length !== TAG_BYTES || envelope.ciphertext.length < 1) {
      throw new CredentialInvalidError();
    }
    return gcmDecrypt(dataKey, envelope.ciphertext, envelope.payloadNonce, envelope.payloadTag, associatedData('payload', binding));
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Rotation step: unwraps the data key with its recorded version and re-wraps
 * it with the active version. The payload ciphertext — and the secret — are
 * never touched.
 */
export function rewrapDataKey(keyRing: MasterKeyRing, binding: CredentialBinding, wrapped: WrappedDataKey): WrappedDataKey {
  const dataKey = unwrap(keyRing, binding, wrapped);
  try {
    return wrap(keyRing, binding, dataKey);
  } finally {
    dataKey.fill(0);
  }
}
