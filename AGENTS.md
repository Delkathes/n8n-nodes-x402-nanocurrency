# AGENTS.md - n8n-nodes-x402nano

Guidelines for agentic coding tools working on the n8n-nodes-x402nano repository,
an n8n community node package implementing the x402 payment protocol with Nano (XNO).

## Project Overview

x402 is an HTTP payment protocol: a server responds `402 Payment Required` with
payment requirements, and the client retries the request with a signed payment
(Nano send block) in a header. This package provides both sides for n8n:

- **X402 Nano** (`nodes/X402Nano/X402Nano.node.ts`) — client (payer): Pay,
  Probe, Build Payment Signature, Verify/Settle/Supported against a facilitator,
  Probe Upstream Price.
- **X402 Nano Trigger** (`nodes/X402Nano/X402NanoTrigger.node.ts`) — resource
  server (seller): webhook that passes requests to the workflow, which answers
  with 402 + `PAYMENT-REQUIRED` or 200 + `PAYMENT-RESPONSE` via a
  Respond to Webhook node.

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
nodes/X402Nano/         # client node + trigger node + icons
utils/                  # vendored crypto, block builder, header codecs
types/                  # x402 v1/v2 + Nano types
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
