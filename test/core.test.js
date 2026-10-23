import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  callVerify,
  callHealth,
  describeChallenge,
  buildArtifactPayload,
  buildTxPayload,
} from '../src/core.js';
import { handleTool, TOOLS } from '../src/server.js';

const BASE = 'https://agent.ggez.my.id';
const ART = { path: 'dist/a.txt', sha256: 'a'.repeat(64) };

/** Minimal Response-like object. */
function res(status, body, { text = false } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (text ? String(body) : JSON.stringify(body)),
  };
}

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    for (const r of routes) {
      if (url.includes(r.match)) return typeof r.respond === 'function' ? r.respond(init) : r.respond;
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  impl.calls = calls;
  return impl;
}

const CHALLENGE = {
  x402Version: 1,
  error: 'payment required: 0.1 USDC on base to 0x5033036702CCeeE23b79022e938a41e0452F908a (x402 scheme \'exact\')',
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '100000',
      resource: `${BASE}/verify-api/verify`,
      payTo: '0x5033036702CCeeE23b79022e938a41e0452F908a',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      maxTimeoutSeconds: 300,
    },
  ],
};

// 1
test('health (free) hits /verify-api/health and parses pricing', async () => {
  const fetchImpl = fakeFetch([
    { match: '/verify-api/health', respond: res(200, { ok: true, service: 'hashn-verify-api', network: 'base', price_usdc: '0.1' }) },
  ]);
  const out = await callHealth({ fetchImpl, env: {} });
  assert.equal(out.structuredContent.ok, true);
  assert.equal(out.structuredContent.price_usdc, '0.1');
  assert.match(out.structuredContent.endpoint, /\/verify-api\/health$/);
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.equal(fetchImpl.calls[0].init.headers['X-PAYMENT'], undefined);
});

// 2
test('verify_artifact without X402_PAYMENT_HEADER returns a structured 402, never a verdict', async () => {
  const fetchImpl = fakeFetch([{ match: '/verify-api/verify', respond: res(402, CHALLENGE) }]);
  const out = await handleTool('verify_artifact', ART, { fetchImpl, env: {} });
  const s = out.structuredContent;
  assert.equal(s.error, 'payment_required');
  assert.equal(s.http_status, 402);
  assert.equal(s.price_usdc, '0.10');
  assert.equal(s.amount_atomic, '100000');
  assert.equal(s.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(s.pay_to, '0x5033036702CCeeE23b79022e938a41e0452F908a');
  assert.equal(s.how_to_pay.env_var, 'X402_PAYMENT_HEADER');
  assert.deepEqual(s.raw_402_body, CHALLENGE, 'raw 402 body is preserved verbatim');
  assert.equal(s.verdict, undefined, 'must not fabricate a verdict');
  assert.equal(out.isError, undefined);
  assert.match(out.content[0].text, /No verdict was produced/);
  assert.equal(fetchImpl.calls[0].init.headers['X-PAYMENT'], undefined);
});

// 3
test('verify_artifact sends X-PAYMENT and passes through the PASS verdict', async () => {
  const fetchImpl = fakeFetch([
    {
      match: '/verify-api/verify',
      respond: res(200, { verdict: 'PASS', items: [{ path: 'dist/a.txt', status: 'PASS' }], report: '# report', payment: { amount: '0.1' } }),
    },
  ]);
  const out = await handleTool('verify_artifact', ART, { fetchImpl, env: { X402_PAYMENT_HEADER: 'cGF5bG9hZA==' } });
  assert.equal(out.structuredContent.verdict, 'PASS');
  assert.equal(fetchImpl.calls[0].init.headers['X-PAYMENT'], 'cGF5bG9hZA==');
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(sent.files[0], { path: 'dist/a.txt', sha256: 'a'.repeat(64) });
});

// 4
test('verify_artifact lowercases the digest and forwards size_bytes', async () => {
  const fetchImpl = fakeFetch([{ match: '/verify-api/verify', respond: res(200, { verdict: 'PARTIAL', items: [], report: '' }) }]);
  await handleTool('verify_artifact', { path: 'x.bin', sha256: 'AB'.repeat(32), size_bytes: 12 }, { fetchImpl, env: { X402_PAYMENT_HEADER: 'p' } });
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.files[0].sha256, 'ab'.repeat(32));
  assert.equal(sent.files[0].size_bytes, 12);
});

// 5
test('verify_base_tx without payment returns 402 challenge with payTo and raw body', async () => {
  const fetchImpl = fakeFetch([{ match: '/verify-api/verify', respond: res(402, CHALLENGE) }]);
  const out = await handleTool('verify_base_tx', { tx_hash: '0x' + 'b'.repeat(64), expect_usdc: '0.10' }, { fetchImpl, env: {} });
  const s = out.structuredContent;
  assert.equal(s.error, 'payment_required');
  assert.equal(s.pay_to, '0x5033036702CCeeE23b79022e938a41e0452F908a');
  assert.ok(s.raw_402_body.accepts.length === 1);
  assert.equal(s.verdict, undefined);
});

// 6
test('verify_base_tx returns the decoded tx verdict', async () => {
  const fetchImpl = fakeFetch([
    { match: '/verify-api/verify', respond: res(200, { verdict: 'PASS', tx: { found: true, to: '0xabc', usdc: '0.10' }, items: [], report: 'ok' }) },
  ]);
  const out = await handleTool('verify_base_tx', { tx_hash: '0x' + 'c'.repeat(64), expect_to: '0xabc', expect_usdc: '0.1' }, { fetchImpl, env: { X402_PAYMENT_HEADER: 'p' } });
  assert.equal(out.structuredContent.verdict, 'PASS');
  assert.equal(out.structuredContent.tx.to, '0xabc');
  const sent = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sent.tx.hash, '0x' + 'c'.repeat(64));
  assert.equal(sent.tx.expect_usdc, '0.1');
});

// 7
test('invalid input is rejected before any network call', async () => {
  const fetchImpl = fakeFetch([]);
  const badSha = await handleTool('verify_artifact', { path: 'x', sha256: 'nothex' }, { fetchImpl, env: {} });
  assert.equal(badSha.isError, true);
  assert.match(badSha.content[0].text, /64 hexadecimal/);
  const badTx = await handleTool('verify_base_tx', { tx_hash: '0x123' }, { fetchImpl, env: {} });
  assert.equal(badTx.isError, true);
  const missing = await handleTool('verify_artifact', { path: 'x' }, { fetchImpl, env: {} });
  assert.equal(missing.isError, true);
  assert.equal(fetchImpl.calls.length, 0, 'no fetch on invalid input');
});

// 8
test('upstream 500 and network failure are reported, not masked as a verdict', async () => {
  const f500 = fakeFetch([{ match: '/verify-api/verify', respond: res(500, { error: 'boom' }) }]);
  const out500 = await handleTool('verify_artifact', ART, { fetchImpl: f500, env: {} });
  assert.equal(out500.structuredContent.error, 'upstream_error');
  assert.equal(out500.structuredContent.http_status, 500);
  assert.equal(out500.structuredContent.verdict, undefined);

  const boom = async () => { throw new Error('ECONNREFUSED'); };
  const outNet = await handleTool('verify_artifact', ART, { fetchImpl: boom, env: {} });
  assert.equal(outNet.structuredContent.error, 'network_error');
  assert.match(outNet.structuredContent.message, /ECONNREFUSED/);
});

// 9
test('402 after a payment was sent explains the retry rather than pretending success', async () => {
  const fetchImpl = fakeFetch([{ match: '/verify-api/verify', respond: res(402, CHALLENGE) }]);
  const out = await handleTool('verify_artifact', ART, { fetchImpl, env: { X402_PAYMENT_HEADER: 'stale' } });
  assert.equal(out.structuredContent.error, 'payment_required');
  assert.equal(out.structuredContent.payment_header_sent, true);
  assert.match(out.structuredContent.message, /still answered 402/);
  assert.equal(out.structuredContent.verdict, undefined);
});

// 10
test('challenge parsing handles v2-style amount and missing accepts', () => {
  assert.equal(describeChallenge({ accepts: [{ amount: '250000', asset: '0xA', payTo: '0xB' }] }).price_usdc, '0.25');
  const empty = describeChallenge({}, { price_usdc: '0.10', asset: '0xA', pay_to: '0xB' });
  assert.equal(empty.price_usdc, '0.10');
  assert.equal(empty.pay_to, '0xB');
});

// 11
test('tool catalog is exactly the three documented tools', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['verify_artifact', 'verify_base_tx', 'health']);
  for (const t of TOOLS) assert.equal(t.inputSchema.type, 'object');
});
