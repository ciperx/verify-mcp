#!/usr/bin/env node
/**
 * verify-mcp — MCP server (stdio) for the HashN Verify API.
 *
 * Tools:
 *   verify_artifact  (paid, 0.10 USDC via x402) — SHA-256 of an artifact
 *   verify_base_tx   (paid, 0.10 USDC via x402) — decode a Base USDC Transfer
 *   health           (free)                     — liveness / pricing probe
 *
 * Transport: JSON-RPC 2.0 over stdio (Model Context Protocol).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  callHealth,
  callVerify,
  buildArtifactPayload,
  buildTxPayload,
  textResult,
} from './core.js';

export const SERVER_INFO = { name: 'verify-mcp', version: '1.0.0' };

const HEX64 = /^[0-9a-f]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export const TOOLS = [
  {
    name: 'verify_artifact',
    description:
      'Verify the SHA-256 digest of a file or artifact. The API recomputes the hash server-side and returns a PASS/PARTIAL/FAIL verdict. Paid: 0.10 USDC on Base via x402. Without X402_PAYMENT_HEADER the tool returns the payment challenge (price, asset, payTo, raw 402 body) instead of a verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Artifact path or label to verify.' },
        sha256: { type: 'string', description: 'Claimed SHA-256 hex digest (64 hex chars).', pattern: '^[0-9a-fA-F]{64}$' },
        size_bytes: { type: 'integer', description: 'Optional claimed size in bytes.', minimum: 0 },
        content_b64: { type: 'string', description: 'Optional base64 of the bytes to hash (alternative to path lookup).' },
      },
      required: ['path', 'sha256'],
      additionalProperties: false,
    },
  },
  {
    name: 'verify_base_tx',
    description:
      'Decode the USDC Transfer log of a Base transaction and check recipient/amount. Returns PASS/PARTIAL/FAIL. Paid: 0.10 USDC on Base via x402. Without X402_PAYMENT_HEADER the tool returns the payment challenge instead of a verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        tx_hash: { type: 'string', description: 'Base transaction hash (0x + 64 hex chars).', pattern: '^0x[0-9a-fA-F]{64}$' },
        expect_to: { type: 'string', description: 'Expected USDC recipient address.' },
        expect_usdc: { type: 'string', description: 'Expected USDC amount, e.g. "0.10".' },
      },
      required: ['tx_hash'],
      additionalProperties: false,
    },
  },
  {
    name: 'health',
    description: 'Free liveness and pricing probe for the HashN Verify API (no payment, no x402 challenge).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function fail(message) {
  return { isError: true, ...textResult({ error: 'invalid_input', message }) };
}

/** Pure handler: takes a tool name + args, returns an MCP CallToolResult. */
export async function handleTool(name, args = {}, opts = {}) {
  if (name === 'health') {
    return callHealth(opts);
  }

  if (name === 'verify_artifact') {
    const { path, sha256, size_bytes, content_b64 } = args ?? {};
    if (!path || typeof path !== 'string') return fail('`path` is required.');
    if (!sha256 || typeof sha256 !== 'string') return fail('`sha256` is required (64 hex characters).');
    const digest = sha256.trim().toLowerCase();
    if (!HEX64.test(digest)) return fail('`sha256` must be exactly 64 hexadecimal characters.');
    return callVerify(buildArtifactPayload({ path, sha256: digest, size_bytes, content_b64 }), opts);
  }

  if (name === 'verify_base_tx') {
    const { tx_hash, expect_to, expect_usdc } = args ?? {};
    if (!tx_hash || typeof tx_hash !== 'string') return fail('`tx_hash` is required.');
    if (!TX_HASH.test(tx_hash.trim())) return fail('`tx_hash` must be 0x followed by 64 hexadecimal characters.');
    return callVerify(buildTxPayload({ tx_hash, expect_to, expect_usdc }), opts);
  }

  return { isError: true, ...textResult({ error: 'unknown_tool', message: `Unknown tool: ${name}` }) };
}

export function createServer(opts = {}) {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params ?? {};
    try {
      return await handleTool(name, args ?? {}, opts);
    } catch (err) {
      return { isError: true, ...textResult({ error: 'tool_error', message: err?.message ?? String(err) }) };
    }
  });

  return server;
}

export async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only: stdout carries the JSON-RPC stream.
  console.error(`verify-mcp ${SERVER_INFO.version} ready on stdio (3 tools; health free, verify 0.10 USDC via x402)`);
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('verify-mcp fatal:', err);
    process.exit(1);
  });
}
