// Node adapter: how a node:http request becomes a Fetch Request (QA).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRequest } from '../src/node-server.js';

const fake = headers => ({ method: 'GET', url: '/api/login', headers: { host: 'localhost', ...headers }, socket: { remoteAddress: '10.0.0.2' } });

test('client IP: socket address; client-sent cf-connecting-ip ignored; behind a proxy the last X-Forwarded-For entry (QA)', () => {
  assert.equal(toRequest(fake({ 'cf-connecting-ip': '1.2.3.4' }), {}).headers.get('cf-connecting-ip'), '10.0.0.2');
  assert.equal(toRequest(fake({ 'x-forwarded-for': '1.2.3.4' }), {}).headers.get('cf-connecting-ip'), '10.0.0.2', 'XFF ignored without TRUST_PROXY');
  // Client sends a fake XFF; the proxy appends the real address. The leftmost value must not be used.
  assert.equal(toRequest(fake({ 'x-forwarded-for': '6.6.6.6, 203.0.113.5' }), { TRUST_PROXY: '1' }).headers.get('cf-connecting-ip'), '203.0.113.5');
  assert.equal(toRequest(fake({ 'cf-access-authenticated-user-email': 'a@b.c' }), {}).headers.get('cf-access-authenticated-user-email'), null);
});
