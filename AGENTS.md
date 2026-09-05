# AGENTS.md - n8n-nodes-x402-nanocurrency

Guidelines for agentic coding tools working on the n8n-nodes-x402-nanocurrency repository,
an n8n community node package implementing the x402 payment protocol with Nano (XNO).

## Project Overview

x402 is an HTTP payment protocol: a server responds `402 Payment Required` with
payment requirements, and the client retries the request with a signed payment
(Nano send block) in a header. This package provides both sides for n8n:

- **X402 Nano** (`nodes/X402Nano/X402Nano.node.ts`) — client (payer): Pay,
  Probe, Build Payment Signature, Verify/Settle/Receive Pending/Supported
  (facilitator or local Nano RPC), Probe Upstream Price.
  - Local Verify Payment is best-effort: signature, payTo, work_validate
    (valid_all/legacy valid only — receive-tier work is rejected for sends),
    payer frontier + confirmed frontier, replay detection (block_info).
    Replayed payments that match the requirements (payer, amount, payTo,
    subtype send) count as valid — idempotent, so client retries after a
    processed payment do not double-charge. Replay validity does not wait
    for confirmation (by design). Settlement (process) is the authoritative
    gate. Cross-server dedupe needs a facilitator.
  - Receive Pending broadcasts open/receive blocks for confirmed pending
    sends (local-mode sellers must call it to move funds out of pending).
    Open-block proof of work is generated over the account public key
    (not the 64-zero previous hash); an optional representative parameter
    applies to open blocks only. Receive blocks use receive-tier work
    difficulty with a base-difficulty fallback.
  - The client node is the only AI-tool node (`usableAsTool: true`, with an
    inline warning that agents must never drive real payments with untrusted
    inputs).
- **X402 Nano Paywall** (`nodes/X402Nano/X402NanoPaywall.node.ts`,
  `handlers/paywall-handler.ts`) — drop-in seller node placed after a built-in
  Webhook node. One pass per request: no usable payment header -> output 0
  with a ready 402 envelope (`buildPaymentRequiredResponse`); valid payment ->
  verify then settle (`runPaymentSettlement`) -> output 1 with a ready 200
  envelope (`buildPaymentResponseEnvelope`); invalid -> 402 UNLESS the block is
  already on-chain and paid exactly these requirements (`detectOnChainReplay`),
  in which case it is answered idempotently on output 1 (`replayed: true`)
  without settling again. `autoSettle: false` emits the verified, unsettled
  payment on output 1 for later manual settlement. A failed settle raises a
  node error (never a 402) so the client retries the same signature.
  `usableAsTool` is omitted (absent = not an AI tool): a settlement-capable
  seller node must never be agent-invocable, so the mandatory community lint
  rule `@n8n/community-nodes/node-usable-as-tool` is suppressed on this class.
  Facilitator-mode settlement (here and on the client node) runs an optional
  on-chain debit guard (`checkOnChainAmount` inside `runPaymentSettlement`,
  operation-dispatcher): if a Nano RPC is reachable and the block is on-chain
  with a different amount than required, settlement is refused — a broken or
  malicious facilitator cannot undersell the merchant.
- **X402 Nano Classify** (`nodes/X402Nano/X402NanoClassify.node.ts`) — resource
  server (seller): transform node with two labeled outputs (Unpaid request /
  Paid request) placed after a built-in Webhook node. Classifies requests
  natively via `utils/paywall-classifier.ts` (`classifyPaywallRequest`):
  normalized lowercase headers + `payment` object (`hasPayment`, `protocol`,
  `headerName`, `headerValue`, `headerInvalid`). Classification only — no
  payload decoding (Verify Payment's job). Like the Paywall node,
  `usableAsTool` is omitted (absent = not an AI tool; the community lint rule
  is suppressed on this class). IMPORTANT: a custom webhook TRIGGER
  node cannot drive a Respond to Webhook workflow — the Respond to Webhook
  node only accepts `n8n-nodes-base.webhook`, `formTrigger`, `chatTrigger` and
  `wait` as ancestor types (verified against n8n 2.36
  RespondToWebhook.node.js WEBHOOK_NODE_TYPES). That is why classification is
  a transform node, not a trigger. Webhook plumbing is left to the built-in
  Webhook node: its path parameter is full-path (`isFullPath`) and n8n does
  NOT resolve `{{$webhookId}}` placeholders in paths (verified against
  getNodeWebhookPath in n8n 2.36).

## Hard rules

1. **No runtime dependencies.** n8n community node packages must have an empty
   `dependencies` field. Crypto (BLAKE2b, ed25519-blake2b), block building and
   header codecs must be vendored into `utils/` (see the sibling
   `n8n-nodes-nano-rpc` repo for the vendored crypto pattern).
2. Protocol version handling: v1 (body `accepts` + `X-PAYMENT` header) and v2
   (`PAYMENT-REQUIRED`/`PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE` headers) differ in
   carrier, envelope and field names (`maxAmountRequired` vs `amount`). Client
   auto-detects; server defaults to dual-mode (both formats emitted).
3. Use `NodeOperationError` (never bare `Error`) for execution errors;
   `this.helpers.httpRequestWithAuthentication` instead of manual auth headers.
4. Keep parameter names unique across the node description.

## Commands

```bash
pnpm run build       # n8n-node build
pnpm run build:watch # tsc --watch
pnpm run dev         # n8n-node dev
pnpm run lint        # n8n-node lint
pnpm run lint:fix    # n8n-node lint --fix
pnpm test            # vitest run
pnpm test:watch      # vitest
pnpm run release     # release-it: bump, changelog, commit, tag, push
```

## Code style

- TypeScript: strict, CommonJS, target ES2020, output `./dist/`
- Prettier: tabs, single quotes, semi, trailing commas, printWidth 100
- Naming: classes PascalCase (`X402Nano`), interfaces `I` prefix, functions
  camelCase, files kebab-case
- Imports grouped: external → internal utils → types → local
- Node descriptions follow n8n conventions (descriptions end with a period,
  boolean descriptions start with "Whether")

## Structure

```
credentials/            # x402FacilitatorApi + x402NanoApi
nodes/X402Nano/         # client node + paywall + classify nodes + icons
utils/                  # vendored crypto, block builder, header codecs
test/                   # vitest tests
.github/workflows/      # ci.yml (lint/test/build) + publish.yml (OIDC npm publish)
```

## Protocol quick reference

- v1 402 body (classic): `{x402Version: 1, accepts: [{scheme, network, maxAmountRequired, payTo, asset, resource, description, mimeType, maxTimeoutSeconds, extra}]}`
- v1 402 body (current NanoGPT, requires `x-x402: true` header): `{error, payment: {version: 1, paymentId, expiresAt, statusUrl, completeUrl, accepted: [{scheme, protocolScheme, network, amount, payTo, paymentId, ...}]}}` — the exact scheme is `protocolScheme: "exact"` (`scheme: "nano-exact"`) with `network: "nano:mainnet"`; the parser handles both shapes.
- v2 402 header `PAYMENT-REQUIRED`: base64 JSON `{x402Version: 2, resource: {...}, accepts: [{scheme, network, amount, payTo, asset, maxTimeoutSeconds, extra}]}`
- v1 payment header `X-PAYMENT`: base64 `{x402Version: 1, scheme, network, payload: {paymentId?, block}}`
- v2 payment header `PAYMENT-SIGNATURE`: base64 `{x402Version: 2, scheme, network, accepted, payload: {block}}`
- Settlement: `X-PAYMENT-RESPONSE` (v1) / `PAYMENT-RESPONSE` (v2): `{success, transaction, network, payer}`
- Facilitator: `/supported` (GET), `/verify` (POST), `/settle` (POST) with `{paymentPayload, paymentRequirements}`

## References

- Live facilitator: `x402-nano-facilitator` repo (Next.js, `src/lib/x402/`)
- Reference client/server patterns: `turbo-x402-exchange` repo
  (`packages/x402-v1`, `packages/x402-nano`, `apps/x402-nano-gpt-proxy`)
- Vendored crypto to port: `n8n-nodes-rpc-commands` repo (`utils/blake2b.ts`,
  `utils/ed25519-blake2b.ts`, `utils/nano-address.ts`, `utils/block-signature.ts`)
