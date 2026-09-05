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
| Payment | Verify Payment | Verify a payment payload against the expected requirements (facilitator or local Nano RPC). Local mode checks signature, payTo, the exact debited amount, proof of work, payer frontier + confirmation and replay; replayed payments matching the requirements are valid (idempotent), so client retries never double-charge. Best-effort — settlement remains the authoritative gate |
| Payment | Settle Payment | Settle a verified payment block and get the transaction hash (facilitator or local Nano RPC) |
| Payment | Receive Pending | Receive all confirmed pending sends on the configured account by broadcasting open/receive blocks (use after local settlement to move funds out of the pending state) |
| Payment | Get Supported | List the facilitator's supported payment kinds |
| Payment | Probe Upstream Price | Call a paywalled upstream URL, parse its v1/v2 requirements, apply a markup percentage |
| Response | Build 402 Payment Required | Build the 402 headers + body for a paywall webhook (v1, v2 or both, optional maxTimeoutSeconds) |
| Response | Build Payment Response | Build the settlement response headers for a paid request |

### `X402 Nano Paywall` node (resource server — seller, recommended)

The drop-in way to turn a workflow into a paid endpoint: classify, verify and
settle in one pass. Place it **after a built-in Webhook node** (the Respond to
Webhook node only works with the built-in Webhook / Form / Chat triggers) and
answer its two labeled outputs with Respond to Webhook nodes:

- **`Payment required`** — the request carried no usable payment header, or
  the payment failed verification. The item is a ready 402 envelope
  (`statusCode`, `headers` with `PAYMENT-REQUIRED`, `body` with the v1/v2
  requirements) — respond `{{ $json.statusCode }}` / `{{ $json.headers }}` /
  `{{ $json.body }}`.
- **`Payment received`** — the payment verified. By default it is also
  **settled automatically** and the item is a ready 200 envelope
  (`statusCode`, `headers` with `PAYMENT-RESPONSE` / `X-PAYMENT-RESPONSE`,
  `body`). With **Settle Automatically** off, the item carries the verified,
  *unsettled* payment (`settled: false`, `verified: true`, `payTo`,
  `amountNano`, `amountRaw`) so you can settle it later with Settle Payment.

Already-settled retries are answered idempotently on `Payment received`
(`replayed: true`, with the settlement headers, no second settle): the node
detects the send on-chain (payer, amount, payTo, `subtype: send`) even when
local verification rejects it. Replay detection requires a reachable Nano RPC
(`x402NanoApi` credential); without one, such retries surface as errors
instead of double-charging. When a `paymentId` is configured, the payment
header's paymentId must match the request's — a payment made for a different
request cannot unlock this one. Note the trade-off: without a per-request
`paymentId`, a settled payment can be replayed by its payer for the same-priced
resource. A failed **settlement** raises a node error — never a 402 — so the
client retries the same signature instead of paying twice.

```
Webhook → X402 Nano Paywall (request with or without payment)
├─ Payment required → Respond 402 + PAYMENT-REQUIRED
└─ Payment received → Respond 200 + PAYMENT-RESPONSE
```

Configure `payTo`, `amount` (NANO) and optional `paymentId`, service/resource
metadata, `protocol` (v1 / v2 / both, dual-mode by default),
`verificationMode` and `settleMode` (facilitator or local Nano RPC — both
credentials are optional). `amount` can be an expression for dynamic pricing.

**Per-request `paymentId` (recommended for sellers).** Bind each request to a
fresh identifier so a settled payment can never be reused for another request:

| Parameter | Expression |
| --- | --- |
| `Amount (NANO)` | `={{ $json.body.tokens * 0.00002 }}` — dynamic price per request |
| `Payment ID` | `={{ $json.headers['x-request-id'] ?? $execution.id }}` — the payer echoes it back |

Set a fixed `amount` and leave `paymentId` empty only when a static,
replayable price is acceptable (see *Risk & trust model*).

### `X402 Nano Classify` node (resource server — seller, building block)

Low-level alternative to `X402 Nano Paywall` when you want to interleave your
own verify/settle logic between classification and responding. Place it
**after a built-in Webhook node** (the Respond to Webhook node only works with
the built-in Webhook / Form / Chat triggers) and it classifies every request
into two labeled outputs:

- **`Unpaid request`** — no v1/v2 payment header (probe requests; GET
  doubles as a browser probe and lands here → answer 402)
- **`Paid request`** — a payment header is present. The item carries
  `payment: { hasPayment, protocol ('v2'|'v1'), headerName, headerValue,
  headerInvalid }` plus normalized lowercase `headers`. When
  `headerInvalid` is `true` the client sent an unusable payment header
  (empty or non-base64) — answer a distinct 402 rather than re-offering.
  Classification only; content verification stays in Verify Payment.

The built-in Webhook node's `Path` parameter controls the webhook URL:

- **empty** (default) → unique URL per instance: `…/webhook/<webhookId>`
- **static path** (e.g. `x402`) → `…/webhook/x402` (one paywall per instance)
- **dynamic path** (e.g. `x402/:id`) → `…/webhook/<webhookId>/x402/<anything>`,
  captured in `$json.params`

```
Webhook → X402 Nano Classify (request with or without payment)
├─ Unpaid output   → Build 402 Payment Required → Respond 402 + PAYMENT-REQUIRED
└─ Paid output     → Verify Payment + Settle Payment (facilitator or local RPC)
                    → your business nodes (NanoGPT, ...)
                    → Build Payment Response → Respond 200 + PAYMENT-RESPONSE
```

> Unless you need to run your own business nodes between verification and
> responding, prefer the one-node `X402 Nano Paywall` flow above.

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

## Risk & trust model

Read this before wiring real money.

- **Facilitator vs local is a trust decision.** `verificationMode`/`settleMode`
  `facilitator` delegates verify and settlement to the facilitator you point
  at: you trust it to check that a payment really matches your requirements
  and to process the block. `local` verifies and settles against your own Nano
  RPC — you check everything yourself. Facilitator settlement (paywall
  auto-settle and the client `Settle Payment` operation) adds a best-effort
  on-chain amount check before settling *when a Nano RPC credential is
  reachable*: if the block is already on-chain with a different amount than
  required, settlement is refused, so a broken or malicious facilitator cannot
  undersell you.
- **Idempotent retries need your RPC.** Retry protection (answering an
  already-settled payment idempotently instead of re-charging) resolves the
  block against a Nano RPC. Assign an `x402 Nano API` credential even in
  facilitator mode; without one, a retry of a settled payment surfaces as a
  node error (the client never pays twice, but the request fails until you
  add the credential).
- **Static paywalls are replayable by their payer.** A payment for a fixed
  price unlocks that price forever unless you bind it to a request. Set a
  **per-request `paymentId`** (an expression) on the paywall so a settled
  payment can only be used for the one request it was made for. Per-request
  `paymentId` is the recommended pattern for anything you sell.
- **Forged requests are cheap.** A header that does not carry a valid Nano
  signature is answered `402` without any RPC call, so random clients cannot
  turn the paywall into a free RPC oracle. Abuse (hammering your endpoint
  with free 402 probes) is handled upstream of this node — rate-limit the
  webhook, keep business logic behind the `Payment received` output, and never
  serve content before verification + settlement.
- **This is real money.** Payments are irrevocable Nano sends. Test with
  dust amounts and a disposable `payTo` account before going live. The client
  node only ever pays from the account configured in its credential.
- **Only the client node is an AI tool.** The `X402 Nano` client node is
  exposed to agents (`usableAsTool`) and shows a warning that a prompt
  injection could trigger real payments from the credential's account. The
  `X402 Nano Paywall` and `X402 Nano Classify` nodes are intentionally **not**
  AI tools — a settlement-capable seller node must not be agent-invocable.

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
