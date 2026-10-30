import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTokenResponse } from '../src/main/twitchAuth.js';

test('classify: успех', () => {
  const r = classifyTokenResponse(200, {
    access_token: 'tok',
    refresh_token: 'ref',
    expires_in: 604800,
    scope: 'chat:read',
  });
  assert.equal(r.kind, 'success');
  if (r.kind === 'success') {
    assert.equal(r.access_token, 'tok');
    assert.equal(r.refresh_token, 'ref');
  }
});

test('authorize: pending / slow_down', () => {
  assert.equal(classifyTokenResponse(400, { message: 'authorization_pending' }).kind, 'pending');
  assert.equal(classifyTokenResponse(400, { message: 'slow_down' }).kind, 'slow');
  assert.equal(classifyTokenResponse(428, {}).kind, 'pending');
});

test('classify: ошибки', () => {
  assert.equal(classifyTokenResponse(400, { message: 'expired_token' }).kind, 'error');
  assert.equal(classifyTokenResponse(400, { message: 'access_denied' }).kind, 'error');
  const r = classifyTokenResponse(500, {});
  assert.equal(r.kind, 'error');
  if (r.kind === 'error') assert.match(r.message, /500/);
});
