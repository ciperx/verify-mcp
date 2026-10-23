# verify-mcp

An MCP (Model Context Protocol) server that gives any agent a **verification tool it can trust**: SHA-256 artifact checks and Base USDC transfer decoding, answered by a live API that recomputes hashes server-side and returns `PASS` / `PARTIAL` / `FAIL`.

Built for agents that have to *prove* a deliverable instead of asserting it — bounty submissions, paid API calls, payout reconciliation, artifact handoffs.

- **Transport:** stdio (JSON-RPC 2.0), Node.js **20+**
- **Runtime deps:** `@modelcontextprotocol/sdk` only
- **Free:** `health`
- **Paid:** `verify_artifact`, `verify_base_tx` — **0.10 USDC per call on Base via [x402](https://x402.org)** (no account, no API key, no signup — the payment *is* the auth)

| | |
|---|---|
| Verify API | `https://agent.ggez.my.id/verify-api/verify` |
| Health (free) | `https://agent.ggez.my.id/verify-api/health` |
| OpenAPI | `https://agent.ggez.my.id/openapi.json` |
| Network | Base mainnet (`eip155:8453`) |
| Price | `0.10` USDC (`100000` atomic, 6 decimals) |
| Asset | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC) |
| payTo | `0x5033036702CCeeE23b79022e938a41e0452F908a` |
| Scheme | x402 `exact` |

---

## Tools

### `verify_artifact` (paid)

Recompute a SHA-256 digest server-side and compare it with the claim.

```json
{
  "path": "dist/report.pdf",
  "sha256": "9f2c…64 hex chars…",
  "size_bytes": 1048576
}
```

Optional `content_b64` lets you send the bytes inline instead of a path.

Returns `{ verdict, items[], report }` — `verdict` is `PASS` when every item matches, `PARTIAL` when some do, `FAIL` otherwise.

### `verify_base_tx` (paid)

Decode the USDC `Transfer` log of a Base transaction and check it against what you expected.

```json
{
  "tx_hash": "0x…64 hex chars…",
  "expect_to": "0x5033036702CCeeE23b79022e938a41e0452F908a",
  "expect_usdc": "0.10"
}
```

Use this to prove *you actually paid* — or that someone actually paid you.

### `health` (free)

Liveness + current pricing probe. Useful as a preflight before spending 0.10 USDC.

---

## Install

### Claude Desktop

Add this to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "verify": {
      "command": "npx",
      "args": ["-y", "github:ciperx/verify-mcp"],
      "env": {
        "VERIFY_API_BASE_URL": "https://agent.ggez.my.id"
      }
    }
  }
}
```

Restart Claude Desktop. `health` works immediately; `verify_artifact` and `verify_base_tx` return the x402 challenge until you add a payment header (below).

### Claude Code / any generic MCP client (stdio)

```json
{
  "mcpServers": {
    "verify": {
      "command": "node",
      "args": ["/absolute/path/to/verify-mcp/src/server.js"],
      "env": {
        "VERIFY_API_BASE_URL": "https://agent.ggez.my.id"
      }
    }
  }
}
```

From a checkout:

```bash
git clone https://github.com/ciperx/verify-mcp
cd verify-mcp
npm install          # only @modelcontextprotocol/sdk
node src/server.js   # speaks JSON-RPC on stdin/stdout
```

### Cursor / Windsurf / Cline

Same `mcpServers` block, in the editor's MCP settings file (`~/.cursor/mcp.json` for Cursor).

---

## Paying for a call (x402)

The paid tools never invent a verdict. If `X402_PAYMENT_HEADER` is not set, they return a structured result like this instead:

```json
{
  "error": "payment_required",
  "http_status": 402,
  "price_usdc": "0.10",
  "amount_atomic": "100000",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "pay_to": "0x5033036702CCeeE23b79022e938a41e0452F908a",
  "scheme": "exact",
  "network": "base",
  "message": "Payment required: this tool call costs 0.10 USDC on Base…",
  "how_to_pay": { "env_var": "X402_PAYMENT_HEADER", "max_timeout_seconds": 300 },
  "raw_402_body": { "x402Version": 1, "accepts": [ … ] }
}
```

Flow:

1. Call the tool. Read `raw_402_body.accepts[0]` (or just `pay_to` / `amount_atomic`).
2. Send exactly `100000` atomic USDC on Base to `0x5033036702CCeeE23b79022e938a41e0452F908a`.
3. Build the x402 `X-PAYMENT` payload with your wallet/facilitator and base64-encode it.
4. Export it and restart the server:

```bash
export X402_PAYMENT_HEADER="<base64 x402 payment payload>"
```

5. Call the tool again — that call is served and you get the real verdict.

`X402_PAYMENT_HEADER` is read per request, so a long-running server picks up a refreshed header on the next call without a restart if you start it from a wrapper that re-reads the env. Each paid call consumes one payment.

A 402 returned *after* a payment was sent is reported honestly (`payment_header_sent: true`, "still answered 402") — the header was stale, underfunded, or addressed to the wrong recipient. It is never upgraded to a fake pass.

---

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `X402_PAYMENT_HEADER` | no | — | Base64 x402 `X-PAYMENT` payload for paid tools. Absent → tools return the 402 challenge. |
| `VERIFY_API_BASE_URL` | no | `https://agent.ggez.my.id` | Point at a self-hosted instance of the verify API. |

---

## Tests

```bash
npm test
```

12 offline tests, no network required — `fetch` is injected:

- `health` hits `/verify-api/health` and parses pricing
- `verify_artifact` without a payment header returns a structured 402 with price/asset/payTo/raw body and **no verdict**
- `verify_artifact` sends `X-PAYMENT` and passes the `PASS` verdict through
- digests are lowercased, `size_bytes` forwarded
- `verify_base_tx` 402 path and 200 verdict path
- invalid `path` / `sha256` / `tx_hash` rejected before any network call
- upstream 500 and `ECONNREFUSED` reported as errors, not verdicts
- 402-after-payment explained, never faked
- challenge parser handles v1 `maxAmountRequired` and v2 `amount`
- tool catalog is exactly the three documented tools
- end-to-end stdio test: `initialize` handshake, `tools/list`, unknown-tool error

---

## Layout

```
src/core.js     API client: fetch injection, 402 challenge parser, payload builders
src/server.js   MCP server: tool schemas + handlers over stdio
test/           12 offline tests (node:test)
mcp.json        server manifest read by MCP directories
smithery.yaml   Smithery deployment config
SHA256SUMS.txt  checksums of the published files
```

## License

MIT
