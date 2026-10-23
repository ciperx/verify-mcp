/**
 * End-to-end stdio smoke test: spawn the real server, do the MCP handshake,
 * list tools, and call the free `health` tool. No network needed for tools/list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'src', 'server.js');

test('stdio: initialize handshake, tools/list, and unknown-tool error', async () => {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, VERIFY_API_BASE_URL: 'https://agent.ggez.my.id' },
  });

  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  const send = (id, method, params) =>
    new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    });

  try {
    const init = await send(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify-mcp-test', version: '1.0.0' },
    });
    assert.equal(init.result.serverInfo.name, 'verify-mcp');
    assert.ok(init.result.capabilities.tools);

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await send(2, 'tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.deepEqual(names, ['verify_artifact', 'verify_base_tx', 'health']);
    const art = list.result.tools.find((t) => t.name === 'verify_artifact');
    assert.deepEqual(art.inputSchema.required, ['path', 'sha256']);

    const bad = await send(3, 'tools/call', { name: 'nope', arguments: {} });
    assert.equal(bad.result.isError, true);
  } finally {
    child.kill('SIGKILL');
  }
});
