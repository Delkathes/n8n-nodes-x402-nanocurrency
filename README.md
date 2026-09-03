# n8n-nodes-x402-nanocurrency

An n8n community node package for the **x402 payment protocol** with **Nano (XNO)** — the HTTP 402 paywall for AI APIs and other web resources. Supports both protocol versions (v1 and v2) and works with or without a facilitator.

## Nodes

### `X402 Nano` node (client — payer)

| Resource | Operation | Description |
| --- | --- | --- |
| Request | Pay | Wrap any HTTP request: probe, pay the 402 with Nano, retry, return the paid response + settlement metadata |
| Request | Send with Payment Header | Send a request with an existing `X-PAYMENT`/`PAYMENT-SIGNATURE` header (from Build Payment Signature) and return the paid response |
| Request | Probe | Send a request without paying and get the payment requirements (price, payTo, resource) |
| Payment | Build Payment Signature | Create an `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2) header from a payTo address + amount |
| Payment | Verify Payment | Verify a payment payload against the expected requirements (facilitator or local Nano RPC). Local mode checks signature, payTo, proof of work, payer frontier + confirmation and replay; replayed payments matching the requirements are valid (idempotent), so client retries never double-charge. Best-effort — settlement remains the authoritative gate |
| Payment | Settle Payment | Settle a verified payment block and get the transaction hash (facilitator or local Nano RPC) |
| Payment | Receive Pending | Receive all confirmed pending sends on the configured account by broadcasting open/receive blocks (use after local settlement to move funds out of the pending state) |
| Payment | Get Supported | List the facilitator's supported payment kinds |
| Payment | Probe Upstream Price | Call a paywalled upstream URL, parse its v1/v2 requirements, apply a markup percentage |
| Response | Build 402 Payment Required | Build the 402 headers + body for a paywall webhook (v1, v2 or both, optional maxTimeoutSeconds) |
| Response | Build Payment Response | Build the settlement response headers for a paid request |

### `X402 Nano Trigger` node (resource server — seller)

A webhook that turns any n8n workflow into a paid endpoint (listens on GET and
POST). Two node versions are shipped:

- **v2 (recommended)** — classifies every request into two labeled outputs:
  - **`Unpaid request`** — no v1/v2 payment header (probe requests; GET
    doubles as a browser probe and lands here → answer 402)
  - **`Paid request`** — a payment header is present. The item carries
    `payment: { hasPayment, protocol ('v2'|'v1'), headerName, headerValue,
    headerInvalid }` plus normalized lowercase `headers`. When
    `headerInvalid` is `true` the client sent an unusable payment header
    (empty or non-base64) — answer a distinct 402 rather than re-offering.
    Classification only; content verification stays in Verify Payment.
- **v1** — passthrough: every request (headers, params, query, body) on a
  single output; the workflow decides how to answer.

The `Path` parameter controls the webhook URL (same for both versions):

- **empty** (default) → unique URL per instance: `…/webhook/<webhookId>` — the
  same behavior as the built-in Webhook node, so several paywall workflows can
  run on the same n8n instance without collisions
- **static path** (e.g. `x402`) → `…/webhook/x402` (one paywall per instance)
- **dynamic path** (e.g. `x402/:id`) → `…/webhook/<webhookId>/x402/<anything>`,
  captured in `$json.params`

```
X402 Nano Trigger (request with or without payment)
├─ no payment header  → Build 402 Payment Required → Respond 402 + PAYMENT-REQUIRED
└─ paid request       → Verify Payment + Settle Payment (facilitator or local RPC)
                        → your business nodes (NanoGPT, ...)
                        → Build Payment Response → Respond 200 + PAYMENT-RESPONSE
```

## Protocol versions

x402 has two wire formats. The node handles both, auto-detecting on the client
and defaulting to dual-mode on the server:

| Aspect | v1 | v2 |
| --- | --- | --- |
| 402 carrier | JSON body `{accepts: [...]}` | `PAYMENT-REQUIRED` header (base64 JSON) |
| Accept shape | `maxAmountRequired`, per-accept resource fields | `amount`, top-level `resource` object |
| Payment carrier | `X-PAYMENT` header | `PAYMENT-SIGNATURE` header |
| Payload envelope | `{x402Version:1, scheme, network, payload}` | `{x402Version:2, scheme, network, accepted, payload}` |
| Settlement carrier | `X-PAYMENT-RESPONSE` | `PAYMENT-RESPONSE` |

The Nano block inside `payload` is identical in both versions.

## Credentials

- **x402 Facilitator API** — facilitator base URL + optional API key (`/supported`, `/verify`, `/settle`)
- **x402 Nano API** — Nano node RPC URL + auth, optional wallet (node signing via `enable_control`) or private key (local signing), optional work server

## Known limitations

- **Replay validity does not require confirmation.** A replayed payment is
  treated as valid as soon as the block is on-chain (payer, amount, payTo and
  `subtype: send` all matching), even before it cements — gating on
  confirmation would re-open the retry → 402 → double-charge race. Settlement
  remains the authoritative gate.
- **Cross-server concurrency.** Two paywall endpoints verifying the same
  fresh signature at the same time can both serve it (each sees "not yet
  replayed"). Idempotency protects same-server retries only. For centralized
  deduplication across endpoints, verify/settle through a facilitator.
- **Receive-tier proof of work.** Receive Pending generates the cheaper
  receive-tier work when the node supports it (falls back to base difficulty
  otherwise); x402 payments themselves always require base difficulty.
- **Use `*Raw` fields for arithmetic.** Node outputs carry both raw and
  formatted amounts (`amountRaw`/`amountNano`, `balanceRaw`/`balanceNano`).
  `BigInt()` only works on the integer `*Raw` fields — the formatted decimals
  are display-only.

## Development

```bash
pnpm install
pnpm run lint        # n8n community node lint
pnpm test            # vitest
pnpm run build       # n8n-node build
```

## Releasing

```bash
pnpm run release     # bumps version, changelog, commit, tag, push
```

The tag push triggers the `Publish` workflow, which publishes to npm via OIDC
trusted publishing (no tokens).

## References

- [x402 protocol](https://x402.org/) and [`@x402/core`](https://github.com/x402-foundation/x402)
- [`x402-nano-facilitator`](https://github.com/Delkathes/x402-nano-facilitator) — live facilitator (`/facilitator/supported`, `/facilitator/verify`, `/facilitator/settle`)
- [`turbo-x402-exchange`](https://github.com/Delkathes/turbo-x402-exchange) — reference v1 client and v2 server patterns
- [Nano RPC protocol](https://docs.nano.org/commands/rpc-protocol/)
