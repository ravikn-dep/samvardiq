import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertSafeMetadata, assertSafeReason } from '../src/auditSafety.js';
import { AuditMetadataValidationError, AuditReasonValidationError } from '../src/errors.js';

/** S, T, X, Y of the IDENTITY-W6 adversarial matrix. */

test('S: an arbitrary (non-allow-listed) metadata key is rejected', () => {
  assert.throws(() => assertSafeMetadata({ someRandomKey: 'value' }), AuditMetadataValidationError);
});

test('S (variant): an allow-listed metadata key is accepted', () => {
  assert.doesNotThrow(() => assertSafeMetadata({ fromStatus: 'ACTIVE', toStatus: 'SUSPENDED' }));
});

test('T: credential-like metadata value is rejected even under an allow-listed key', () => {
  assert.throws(() => assertSafeMetadata({ fromStatus: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc' }), AuditMetadataValidationError);
  assert.throws(() => assertSafeMetadata({ fromStatus: 'my-password-is-hunter2' }), AuditMetadataValidationError);
  assert.throws(() => assertSafeMetadata({ fromStatus: 'header.payload.signature' }), AuditMetadataValidationError, 'JWT-shaped value rejected');
});

test('T (reason variant): a JWT/Authorization-header-shaped reason is rejected', () => {
  assert.throws(() => assertSafeReason('Bearer abc.def.ghi'), AuditReasonValidationError);
  assert.throws(() => assertSafeReason('service_role_key=super-secret'), AuditReasonValidationError);
});

test('X: oversized metadata is rejected', () => {
  assert.throws(() => assertSafeMetadata({ fromStatus: 'x'.repeat(1000) }), AuditMetadataValidationError, 'oversized value rejected');
  assert.throws(
    () => assertSafeMetadata({ fromStatus: 'a', toStatus: 'b', fromRole: 'c', toRole: 'd', extraKeyToOverflowLimit: 'e' } as never),
    AuditMetadataValidationError,
    'too many keys rejected',
  );
});

test('X (reason variant): an oversized reason is rejected', () => {
  assert.throws(() => assertSafeReason('x'.repeat(501)), AuditReasonValidationError);
});

test('Y: clinical/patient-shaped metadata is rejected where practical', () => {
  assert.throws(() => assertSafeMetadata({ fromStatus: 'patient diagnosis pending review' }), AuditMetadataValidationError);
});

test('Y (reason variant): a clinical-shaped reason is rejected where practical', () => {
  assert.throws(() => assertSafeReason('updated per patient treatment plan'), AuditReasonValidationError);
});

test('a safe, ordinary reason and metadata pass through unchanged', () => {
  assert.doesNotThrow(() => assertSafeReason('membership suspended by administrator'));
  assert.doesNotThrow(() => assertSafeMetadata({ fromStatus: 'ACTIVE', toStatus: 'SUSPENDED' }));
});
