/**
 * Core client for the HashN Verify API.
 *
 * Free:  GET  https://agent.ggez.my.id/verify-api/health
 * Paid:  POST https://agent.ggez.my.id/verify-api/verify   (x402, 0.10 USDC on Base)
 *
 * Nothing here fakes a verdict. If the API answers 402 and no X-PAYMENT header is
 * configured, the caller gets a structured `payment_required` result containing the
 * price, asset, payTo and the raw 402 body so an agent can pay and retry.
 */

export const DEFAULT_BASE_URL = 'https://agent.ggez.my.id';
export const VERIFY_PATH = '/verify-api/verify';
export const HEALTH_PATH = '/verify-api/health';

const REQUEST_TIMEOUT_MS = 60_000;

function joinUrl(baseUrl, path) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '') + path;
}

function textResult(payload) {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    structuredContent: typeof payload === 'string' ? { text: payload } : payload,
  };
}

/** Pull price/asset/payTo out of an x402 challenge (v1 `accepts[]` or v2 fields). */
export function describeChallenge(body, fallback = {}) {
  const accepts = Array.isArray(body?.accepts) ? body.accepts : [];
  const first = accepts[0] || {};
  const amountAtomic = first.maxAmountRequired ?? first.amount ?? body?.maxAmountRequired ?? null;
  let amountUsdc = null;
  if (amountAtomic !== null && /^\d+$/.test(String(amountAtomic))) {
    // Base USDC has 6 decimals.
    amountUsdc = (Number(amountAtomic) / 1e6).toFixed(2);
  }
  return {
    http_status: 402,
    error: 'payment_required',
    x402_version: body?.x402Version ?? 1,
    scheme: first.scheme ?? 'exact',
    network: first.network ?? 'base',
    price_usdc: amountUsdc ?? fallback.price_usdc ?? null,
    amount_atomic: amountAtomic,
    asset: first.asset ?? fallback.asset ?? null,
    pay_to: first.payTo ?? fallback.pay_to ?? null,
    resource: first.resource ?? fallback.resource ?? null,
    message:
      'Payment required: this tool call costs ' +
      (amountUsdc ?? fallback.price_usdc ?? '0.10') +
      ' USDC on Base, paid to ' +
      (first.payTo ?? fallback.pay_to ?? 'unknown') +
      '. No X402_PAYMENT_HEADER is configured, so the call was not executed. ' +
      'Pay the x402 challenge below (scheme "exact"), then set X402_PAYMENT_HEADER to the ' +
      'base64-encoded X-PAYMENT payload and call this tool again. No verdict was produced.',
    how_to_pay: {
      scheme: first.scheme ?? 'exact',
      network: first.network ?? 'base',
      asset: first.asset ?? fallback.asset ?? null,
      pay_to: first.payTo ?? fallback.pay_to ?? null,
      max_amount_required: amountAtomic,
      max_timeout_seconds: first.maxTimeoutSeconds ?? 300,
      env_var: 'X402_PAYMENT_HEADER',
    },
    raw_402_body: body ?? null,
  };
}

async function readBody(res) {
  const raw = await res.text();
  try {
    return { json: JSON.parse(raw), raw };
  } catch {
    return { json: null, raw };
  }
}

/**
 * Call the paid /verify endpoint.
 * @param {object} payload  {files?: [...], tx?: {hash, expect_to, expect_usdc}, workspace_id?}
 * @param {object} opts     {fetchImpl?, paymentHeader?, baseUrl?, env?}
 */
export async function callVerify(payload, opts = {}) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const paymentHeader = opts.paymentHeader ?? env.X402_PAYMENT_HEADER ?? '';
  const baseUrl = opts.baseUrl ?? env.VERIFY_API_BASE_URL ?? DEFAULT_BASE_URL;

  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (paymentHeader) headers['X-PAYMENT'] = paymentHeader;

  let res;
  try {
    res = await fetchImpl(joinUrl(baseUrl, VERIFY_PATH), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return textResult({
      error: 'network_error',
      message: `Could not reach the verify API: ${err.message}`,
      endpoint: joinUrl(baseUrl, VERIFY_PATH),
    });
  }

  const { json, raw } = await readBody(res);

  if (res.status === 402) {
    const challenge = describeChallenge(json, {
      price_usdc: '0.10',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      pay_to: '0x5033036702CCeeE23b79022e938a41e0452F908a',
      resource: joinUrl(baseUrl, VERIFY_PATH),
    });
    if (paymentHeader) {
      challenge.message =
        'Payment was sent but the API still answered 402. The payment header may be invalid, ' +
        'expired, or for the wrong amount/recipient. No verdict was produced.';
      challenge.payment_header_sent = true;
    }
    challenge.raw_402_body = json ?? raw;
    return textResult(challenge);
  }

  if (!res.ok) {
    return textResult({
      error: 'upstream_error',
      http_status: res.status,
      message: `Verify API returned HTTP ${res.status}.`,
      body: json ?? raw,
    });
  }

  if (!json) {
    return textResult({ error: 'invalid_response', http_status: res.status, message: 'Verify API did not return JSON.', body: raw });
  }

  // Pass through authoritative verdict; never synthesize one.
  return textResult({
    verdict: json.verdict ?? null,
    items: json.items ?? [],
    tx: json.tx ?? null,
    payment: json.payment ?? null,
    report: json.report ?? null,
    http_status: res.status,
    raw: json,
  });
}

/** Call the free health endpoint. */
export async function callHealth(opts = {}) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? env.VERIFY_API_BASE_URL ?? DEFAULT_BASE_URL;
  const url = joinUrl(baseUrl, HEALTH_PATH);
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    return textResult({ error: 'network_error', message: `Could not reach the health endpoint: ${err.message}`, endpoint: url });
  }
  const { json, raw } = await readBody(res);
  if (!res.ok) {
    return textResult({ error: 'upstream_error', http_status: res.status, message: `Health endpoint returned HTTP ${res.status}.`, body: json ?? raw, endpoint: url });
  }
  return textResult({
    ok: json?.ok ?? true,
    service: json?.service ?? null,
    version: json?.version ?? null,
    network: json?.network ?? null,
    price_usdc: json?.price_usdc ?? null,
    pay_to: json?.pay_to ?? null,
    mode: json?.mode ?? null,
    endpoint: url,
    raw: json ?? raw,
  });
}

/** Build the /verify payload for a single artifact. */
export function buildArtifactPayload({ path, sha256, size_bytes, content_b64 }) {
  const item = { path };
  if (sha256 !== undefined) item.sha256 = String(sha256).trim().toLowerCase();
  if (size_bytes !== undefined && size_bytes !== null) item.size_bytes = Number(size_bytes);
  if (content_b64 !== undefined) item.content_b64 = content_b64;
  return { files: [item] };
}

/** Build the /verify payload for a Base transaction. */
export function buildTxPayload({ tx_hash, expect_to, expect_usdc }) {
  const tx = { hash: String(tx_hash).trim() };
  if (expect_to) tx.expect_to = String(expect_to).trim();
  if (expect_usdc !== undefined && expect_usdc !== null) tx.expect_usdc = String(expect_usdc);
  return { tx };
}

export { textResult };
