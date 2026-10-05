import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, test } from 'node:test';

import { associatedData, openCredential, rewrapDataKey, sealCredential, type CredentialBinding, type CredentialEnvelope } from '../src/envelope.js';
import { CredentialInvalidError, KeyRingConfigurationError, KeyUnavailableError } from '../src/errors.js';
import { ACTIVE_KEY_VERSION_ENV, MASTER_KEYS_ENV, MasterKeyRing } from '../src/keyRing.js';

/** Ephemeral test keys only — generated per run, never written anywhere. */
const k = () => randomBytes(32).toString('base64');
const ring = (keys: Record<number, string>, active: number) =>
  MasterKeyRing.fromEnv({ [MASTER_KEYS_ENV]: Object.entries(keys).map(([v, m]) => `${v}:${m}`).join(','), [ACTIVE_KEY_VERSION_ENV]: String(active) });

const K1 = k();
const K2 = k();
const RING = ring({ 1: K1 }, 1);
const BINDING: CredentialBinding = { organizationId: 'org-a', provider: 'google_business_profile', credentialId: 'cred-1', credentialType: 'oauth_refresh_token' };
const SECRET = Buffer.from('1//refresh-token-PLAINTEXT-marker-7f3a', 'utf8');

const flip = (b: Buffer, i = 0) => {
  const c = Buffer.from(b);
  c[i]! ^= 0x01;
  return c;
};
const seal = (binding = BINDING, keyRing = RING) => sealCredential(keyRing, binding, SECRET);

describe('envelope (ARCH-020)', () => {
  test('A: a sealed credential opens to the original secret', () => {
    assert.deepEqual(openCredential(RING, BINDING, seal()), SECRET);
  });

  test('B: the same secret seals differently every time (fresh nonce and data key)', () => {
    const [a, b] = [seal(), seal()];
    for (const field of ['ciphertext', 'payloadNonce', 'payloadTag', 'wrappedKey', 'wrapNonce', 'wrapTag'] as const) assert.notDeepEqual(a[field], b[field], field);
    assert.equal(a.ciphertext.indexOf(SECRET), -1, 'ciphertext does not contain the plaintext');
    assert.equal(a.payloadNonce.length, 12);
    assert.equal(a.payloadTag.length, 16);
    assert.equal(a.wrappedKey.length, 32);
  });

  test('C/D/E: tampered ciphertext, payload tag, wrapped key, wrap nonce or wrap tag fail authentication', () => {
    const e = seal();
    for (const field of ['ciphertext', 'payloadTag', 'payloadNonce', 'wrappedKey', 'wrapTag', 'wrapNonce'] as const) {
      assert.throws(() => openCredential(RING, BINDING, { ...e, [field]: flip(e[field]) }), CredentialInvalidError, field);
    }
  });

  test('D: a truncated tag is rejected, never accepted as a shorter GCM tag', () => {
    const e = seal();
    assert.throws(() => openCredential(RING, BINDING, { ...e, payloadTag: e.payloadTag.subarray(0, 12) }), CredentialInvalidError);
    assert.throws(() => openCredential(RING, BINDING, { ...e, wrapTag: e.wrapTag.subarray(0, 4) }), CredentialInvalidError);
  });

  test('F: a different key configured under the same version fails closed as key_unavailable (key check), not as tampering', () => {
    assert.throws(() => openCredential(ring({ 1: K2 }, 1), BINDING, seal()), KeyUnavailableError);
  });

  test('F: a wrong key with a forged key check still fails authentication', () => {
    const wrong = ring({ 1: K2 }, 1);
    const forged = { ...seal(), keyCheck: sealCredential(wrong, BINDING, SECRET).keyCheck };
    assert.throws(() => openCredential(wrong, BINDING, forged), CredentialInvalidError);
  });

  test('G/H: a version the ring does not hold fails closed — no fallback to another key', () => {
    const e = seal();
    assert.throws(() => openCredential(ring({ 2: K2 }, 2), BINDING, e), KeyUnavailableError);
    assert.throws(() => openCredential(RING, BINDING, { ...e, keyVersion: 7 }), KeyUnavailableError);
  });

  test('I: malformed envelopes fail closed', () => {
    const e = seal();
    const bad: Partial<CredentialEnvelope>[] = [
      { ciphertext: Buffer.alloc(0) },
      { payloadNonce: Buffer.alloc(16) },
      { wrapNonce: e.wrapNonce.subarray(0, 8) },
      { wrappedKey: Buffer.concat([e.wrappedKey, Buffer.alloc(1)]) },
      { keyVersion: 0 },
      { keyVersion: Number.NaN },
      { keyVersion: 1.5 },
    ];
    for (const patch of bad) assert.throws(() => openCredential(RING, BINDING, { ...e, ...patch }), CredentialInvalidError, inspect(Object.keys(patch)));
    assert.throws(() => openCredential(RING, BINDING, { ...e, keyCheck: e.keyCheck.subarray(0, 8) }), KeyUnavailableError);
  });

  test('J/K/L/M: an envelope opened under any other organization, provider, credential ID or type fails', () => {
    const e = seal();
    for (const patch of [{ organizationId: 'org-b' }, { provider: 'meta' }, { credentialId: 'cred-2' }, { credentialType: 'oauth_access_token' }]) {
      assert.throws(() => openCredential(RING, { ...BINDING, ...patch }, e), CredentialInvalidError, JSON.stringify(patch));
    }
  });

  test('AAD serialization is canonical and unambiguous (org=A,provider=BC ≠ org=AB,provider=C)', () => {
    const a = associatedData('payload', { ...BINDING, organizationId: 'A', provider: 'BC' });
    const b = associatedData('payload', { ...BINDING, organizationId: 'AB', provider: 'C' });
    assert.notDeepEqual(a, b);
    assert.deepEqual(associatedData('payload', BINDING), associatedData('payload', { ...BINDING }));
    assert.notDeepEqual(associatedData('data-key', BINDING, 1), associatedData('data-key', BINDING, 2));
    assert.notDeepEqual(associatedData('payload', BINDING), associatedData('data-key', BINDING, 1));
    const sealedAb = sealCredential(RING, { ...BINDING, organizationId: 'A', provider: 'BC' }, SECRET);
    assert.throws(() => openCredential(RING, { ...BINDING, organizationId: 'AB', provider: 'C' }, sealedAb), CredentialInvalidError);
  });

  test('AF/AG: re-wrapping changes only the wrap layer; old and new versions both open under a ring holding both', () => {
    const e = seal();
    const both = ring({ 1: K1, 2: K2 }, 2);
    const rewrapped = { ...e, ...rewrapDataKey(both, BINDING, e) };
    assert.equal(rewrapped.keyVersion, 2);
    assert.deepEqual(rewrapped.ciphertext, e.ciphertext, 'payload untouched');
    assert.deepEqual(openCredential(both, BINDING, rewrapped), SECRET);
    assert.deepEqual(openCredential(both, BINDING, e), SECRET, 'un-rotated envelope still opens');
    assert.deepEqual(openCredential(ring({ 2: K2 }, 2), BINDING, rewrapped), SECRET, 'after rotation the old key is not needed');
    assert.throws(() => openCredential(both, BINDING, { ...rewrapped, keyVersion: 1 }), KeyUnavailableError, 'version is bound to the wrap');
  });
});

describe('master key ring (AO)', () => {
  const env = (keys: string | undefined, active: string | undefined) => ({ [MASTER_KEYS_ENV]: keys, [ACTIVE_KEY_VERSION_ENV]: active });
  const cases: [string, ReturnType<typeof env>][] = [
    ['keys unset', env(undefined, '1')],
    ['keys empty', env('  ', '1')],
    ['active unset', env(`1:${K1}`, undefined)],
    ['active not an integer', env(`1:${K1}`, 'one')],
    ['active zero', env(`1:${K1}`, '0')],
    ['active not listed', env(`1:${K1}`, '2')],
    ['no version prefix', env(K1, '1')],
    ['version zero', env(`0:${K1}`, '0')],
    ['short key', env(`1:${randomBytes(16).toString('base64')}`, '1')],
    ['long key', env(`1:${randomBytes(48).toString('base64')}`, '1')],
    ['base64url, not base64', env(`1:${K1.replace(/\+/g, '-').replace(/\//g, '_').padEnd(44, '=')}-`, '1')],
    ['hex key', env(`1:${randomBytes(32).toString('hex')}`, '1')],
    ['all-zero key', env(`1:${Buffer.alloc(32).toString('base64')}`, '1')],
    ['duplicate version', env(`1:${K1},1:${K2}`, '1')],
    ['same material under two versions', env(`1:${K1},2:${K1}`, '2')],
    ['trailing comma', env(`1:${K1},`, '1')],
  ];
  for (const [name, e] of cases) {
    test(`fails closed: ${name} — and never echoes key material`, () => {
      assert.throws(
        () => MasterKeyRing.fromEnv(e),
        (err: unknown) => {
          assert.ok(err instanceof KeyRingConfigurationError);
          for (const material of [K1, K2]) assert.ok(!err.message.includes(material) && !String(err.stack).includes(material));
          return true;
        },
      );
    });
  }

  test('a valid ring exposes versions and the active version but no key material (JSON/inspect)', () => {
    const r = ring({ 3: K1, 1: K2 }, 3);
    assert.equal(r.activeVersion, 3);
    assert.deepEqual(r.versions, [1, 3]);
    const raw = [Buffer.from(K1, 'base64'), Buffer.from(K2, 'base64')];
    for (const rendered of [JSON.stringify(r), inspect(r, { depth: 10, showHidden: true }), inspect(r.key(3), { depth: 10, showHidden: true })]) {
      for (const material of [K1, K2, ...raw.map((b) => b.toString('hex'))]) assert.ok(!rendered.includes(material), rendered);
    }
  });

  test('a ring is never created from nothing (no silent key generation)', () => {
    assert.throws(() => MasterKeyRing.fromEnv({}), KeyRingConfigurationError);
  });
});
