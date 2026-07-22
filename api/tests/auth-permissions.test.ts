import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { hashToken, safeTokenEqual } from '../src/auth/crypto';
import { hasPermission, isAuthRole } from '../src/auth/permissions';

test('viewer access does not imply access to patient health information', () => {
  assert.equal(hasPermission('viewer', 'dashboard:read'), true);
  assert.equal(hasPermission('viewer', 'phi:read'), false);
  assert.equal(hasPermission('viewer', 'appointments:write'), false);
});

test('clinic administrators cannot manage organization billing or integrations', () => {
  assert.equal(hasPermission('admin', 'billing:read'), true);
  assert.equal(hasPermission('admin', 'billing:write'), false);
  assert.equal(hasPermission('admin', 'integrations:manage'), false);
  assert.equal(hasPermission('owner', 'billing:write'), true);
  assert.equal(hasPermission('owner', 'integrations:manage'), true);
});

test('only the closed role set is accepted', () => {
  assert.equal(isAuthRole('owner'), true);
  assert.equal(isAuthRole('viewer'), true);
  assert.equal(isAuthRole('superadmin'), false);
  assert.equal(isAuthRole('Owner'), false);
});

test('security token comparisons fail closed for a different length or digest', () => {
  const digest = hashToken('one-time-token');
  assert.equal(safeTokenEqual(digest, hashToken('one-time-token')), true);
  assert.equal(safeTokenEqual(digest, hashToken('different-token')), false);
  assert.equal(safeTokenEqual(digest, `${digest}00`), false);
});
