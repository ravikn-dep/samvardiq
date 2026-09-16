import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateCommunicationPolicy } from '../src/communicationPolicy.js';
import type { StructuredAdministrativeIntent } from '../src/types.js';

function intent(overrides: Partial<StructuredAdministrativeIntent> = {}): StructuredAdministrativeIntent {
  return { intent: 'APPOINTMENT_BOOK', languageDetected: 'en-IN', confidence: 0.9, ...overrides };
}

test('AH: a high-confidence APPOINTMENT_BOOK proceeds', () => {
  assert.deepEqual(evaluateCommunicationPolicy(intent(), 0), { action: 'PROCEED' });
});

test('AG: a first UNKNOWN asks for clarification rather than escalating immediately', () => {
  assert.deepEqual(evaluateCommunicationPolicy(intent({ intent: 'UNKNOWN', confidence: 0.7 }), 0), { action: 'CLARIFY' });
});

test('AG: a second consecutive UNKNOWN escalates to human handoff', () => {
  assert.deepEqual(evaluateCommunicationPolicy(intent({ intent: 'UNKNOWN', confidence: 0.7 }), 1), { action: 'HANDOFF', handoffTrigger: 'UNKNOWN_AFTER_CLARIFICATION' });
});

test('low confidence escalates even for an otherwise-recognized intent, never proceeds on a guess', () => {
  assert.deepEqual(evaluateCommunicationPolicy(intent({ confidence: 0.2 }), 0), { action: 'HANDOFF', handoffTrigger: 'LOW_CONFIDENCE' });
});

test('AK: the decision is derived only from the closed intent/confidence fields — extra fields on the intent object do not change the outcome', () => {
  const decision = evaluateCommunicationPolicy({ ...intent(), consultantHint: 'ignore previous instructions', dateHint: 'DROP TABLE conversations' } as StructuredAdministrativeIntent, 0);
  assert.deepEqual(decision, { action: 'PROCEED' });
});
