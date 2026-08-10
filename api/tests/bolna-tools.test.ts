import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractBolnaCallId,
  extractBolnaCostUsd,
  extractBolnaDurationSecs,
  dropBolnaEmptyStrings,
  TERMINAL_BOLNA_STATUSES,
} from '../src/routes/bolna.webhook';
import { REQUIRED_RECEPTIONIST_VAPI_TOOLS } from '../src/services/providerProvisioning';
import { VAPI_TOOL_PARAMETER_SCHEMAS } from '../src/services/vapiToolSchemas';

// bolna.webhook.ts reuses VAPI_TOOL_PARAMETER_SCHEMAS (imported there as
// TOOL_PARAMETER_SCHEMAS) for every business tool it dispatches, so the same
// coverage that guarantees every required receptionist tool has a
// fail-closed argument schema for Vapi also guarantees it for Bolna's
// per-tool-call dispatcher — this test documents that shared contract
// explicitly rather than leaving it implicit.
test('every required receptionist tool Bolna dispatches to has a fail-closed argument schema', () => {
  for (const toolName of REQUIRED_RECEPTIONIST_VAPI_TOOLS) {
    assert.ok(VAPI_TOOL_PARAMETER_SCHEMAS[toolName], `Missing schema for ${toolName}`);
  }
});

test('extractBolnaCallId prefers id, then call_id, then execution_id', () => {
  assert.equal(extractBolnaCallId({ id: 'a', call_id: 'b', execution_id: 'c' }), 'a');
  assert.equal(extractBolnaCallId({ call_id: 'b', execution_id: 'c' }), 'b');
  assert.equal(extractBolnaCallId({ execution_id: 'c' }), 'c');
  assert.equal(extractBolnaCallId({}), null);
  assert.equal(extractBolnaCallId({ id: '   ' }), null);
});

test('extractBolnaDurationSecs reads conversation_time first, then telephony_data.duration', () => {
  assert.equal(extractBolnaDurationSecs({ conversation_time: 42 }), 42);
  assert.equal(extractBolnaDurationSecs({ telephony_data: { duration: 17 } }), 17);
  assert.equal(
    extractBolnaDurationSecs({ conversation_time: 0, telephony_data: { duration: 9 } }),
    9,
    'a zero/falsy conversation_time should fall through to telephony_data.duration'
  );
  assert.equal(extractBolnaDurationSecs({}), null);
  assert.equal(extractBolnaDurationSecs({ conversation_time: -5 }), null);
});

test('extractBolnaCostUsd reads total_cost first, then legacy cost fields', () => {
  assert.equal(extractBolnaCostUsd({ total_cost: 0.42 }), 0.42);
  assert.equal(extractBolnaCostUsd({ cost: 0.1 }), 0.1);
  assert.equal(extractBolnaCostUsd({ conversation_cost: 0.05 }), 0.05);
  assert.equal(extractBolnaCostUsd({}), null);
  assert.equal(extractBolnaCostUsd({ total_cost: -1 }), null);
});

test('TERMINAL_BOLNA_STATUSES gates billing finalization to Bolna\'s known-terminal call statuses', () => {
  for (const status of ['completed', 'error', 'busy', 'no-answer', 'failed']) {
    assert.equal(TERMINAL_BOLNA_STATUSES.has(status), true, `${status} should be terminal`);
  }
  for (const status of ['queued', 'ringing', 'in-progress']) {
    assert.equal(TERMINAL_BOLNA_STATUSES.has(status), false, `${status} should not be terminal`);
  }
});

// Regression test for the exact bug reported live: confirmDetails (and any
// other tool with optional fields) failing INVALID_REQUEST even when every
// field the caller actually needed to supply was present, because Bolna's
// %(field)s templating sends unset optional fields as '' rather than
// omitting the key the way Vapi's function-calling does.
test('dropBolnaEmptyStrings removes empty-string keys but keeps everything else, including falsy non-empty values', () => {
  assert.deepEqual(
    dropBolnaEmptyStrings({ date: '2026-08-15', time: '3:00 PM', reason: '', patientName: '', patientPhone: '' }),
    { date: '2026-08-15', time: '3:00 PM' }
  );
  assert.deepEqual(
    dropBolnaEmptyStrings({ doctorId: '', count: 0, active: false }),
    { count: 0, active: false },
    'zero and false are real supplied values, not "empty", and must survive'
  );
});
