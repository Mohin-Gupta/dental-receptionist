import assert from 'node:assert/strict';
import test from 'node:test';
import { VAPI_TOOL_PARAMETER_SCHEMAS } from '../src/services/vapiToolSchemas';
import { REQUIRED_RECEPTIONIST_VAPI_TOOLS } from '../src/services/providerProvisioning';

test('every required Vapi receptionist tool has a fail-closed argument schema', () => {
  for (const toolName of REQUIRED_RECEPTIONIST_VAPI_TOOLS) {
    assert.ok(VAPI_TOOL_PARAMETER_SCHEMAS[toolName], `Missing schema for ${toolName}`);
  }
  assert.deepEqual(
    Object.keys(VAPI_TOOL_PARAMETER_SCHEMAS).sort(),
    [...REQUIRED_RECEPTIONIST_VAPI_TOOLS].sort()
  );
});

test('caller verification schemas reject model-supplied malformed values', () => {
  assert.equal(VAPI_TOOL_PARAMETER_SCHEMAS.requestCallerVerification.safeParse({
    patientName: 'A',
  }).success, false);
  assert.equal(VAPI_TOOL_PARAMETER_SCHEMAS.verifyCallerCode.safeParse({
    code: '12345',
  }).success, false);
  assert.equal(VAPI_TOOL_PARAMETER_SCHEMAS.verifyCallerCode.safeParse({
    code: '123456',
  }).success, true);
});
