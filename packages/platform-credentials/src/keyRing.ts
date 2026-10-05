import { createSecretKey, type KeyObject } from 'node:crypto';

import { KeyRingConfigurationError, KeyUnavailableError } from './errors.js';

/** Environment variable NAMES (ADR-PLATFORM-001 §4). Values live only in the hosting secret store. */
export const MASTER_KEYS_ENV = 'PROVIDER_CREDENTIAL_MASTER_KEYS';
export const ACTIVE_KEY_VERSION_ENV = 'PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION';

const KEY_BYTES = 32;
const VERSION = /^[1-9]\d{0,8}$/;
// Standard base64 of exactly 32 bytes is 43 significant characters plus one '=' pad.
const ENTRY = /^([1-9]\d{0,8}):([A-Za-z0-9+/]{43}=)$/;

/**
 * The versioned master-key (key-encryption-key) ring. Format:
 *
 *   PROVIDER_CREDENTIAL_MASTER_KEYS        = "<version>:<base64 of 32 random bytes>[,<version>:<base64>...]"
 *   PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION = "<version>"   (must be one of the listed versions)
 *
 * The active version wraps every new or re-wrapped data key; the others only
 * unwrap. Fails closed on anything missing or malformed — it never generates
 * a key. Key material is held only as non-exportable-by-accident KeyObjects
 * in a true private field, so it is absent from JSON, `util.inspect` and
 * error messages; the decoded buffers are zeroed after import.
 */
export class MasterKeyRing {
  readonly #keys: ReadonlyMap<number, KeyObject>;
  readonly activeVersion: number;

  private constructor(keys: Map<number, KeyObject>, activeVersion: number) {
    this.#keys = keys;
    this.activeVersion = activeVersion;
  }

  static fromEnv(env: Readonly<Record<string, string | undefined>> = process.env): MasterKeyRing {
    const rawKeys = env[MASTER_KEYS_ENV]?.trim();
    const rawActive = env[ACTIVE_KEY_VERSION_ENV]?.trim();
    if (!rawKeys) throw new KeyRingConfigurationError(`${MASTER_KEYS_ENV} is not set`);
    if (!rawActive) throw new KeyRingConfigurationError(`${ACTIVE_KEY_VERSION_ENV} is not set`);
    if (!VERSION.test(rawActive)) throw new KeyRingConfigurationError(`${ACTIVE_KEY_VERSION_ENV} is not a positive integer`);

    const keys = new Map<number, KeyObject>();
    const seen: Buffer[] = [];
    try {
      rawKeys.split(',').forEach((entry, index) => {
        const match = ENTRY.exec(entry.trim());
        if (!match) throw new KeyRingConfigurationError(`${MASTER_KEYS_ENV} entry ${index + 1} is not "<version>:<base64 of 32 bytes>"`);
        const version = Number(match[1]);
        if (keys.has(version)) throw new KeyRingConfigurationError(`${MASTER_KEYS_ENV} lists version ${version} more than once`);
        const material = Buffer.from(match[2]!, 'base64');
        seen.push(material);
        if (material.length !== KEY_BYTES || material.toString('base64') !== match[2] || material.every((b) => b === 0)) {
          throw new KeyRingConfigurationError(`${MASTER_KEYS_ENV} version ${version} is not a usable 256-bit key`);
        }
        if (seen.slice(0, -1).some((other) => other.equals(material))) {
          throw new KeyRingConfigurationError(`${MASTER_KEYS_ENV} version ${version} reuses another version's key material`);
        }
        keys.set(version, createSecretKey(material));
      });
    } finally {
      for (const material of seen) material.fill(0);
    }

    const activeVersion = Number(rawActive);
    if (!keys.has(activeVersion)) throw new KeyRingConfigurationError(`active version ${activeVersion} is not in ${MASTER_KEYS_ENV}`);
    return new MasterKeyRing(keys, activeVersion);
  }

  /** The key for one version. An unknown version fails closed — never a fallback to another key. */
  key(version: number): KeyObject {
    const key = this.#keys.get(version);
    if (!key) throw new KeyUnavailableError();
    return key;
  }

  get versions(): number[] {
    return [...this.#keys.keys()].sort((a, b) => a - b);
  }
}
