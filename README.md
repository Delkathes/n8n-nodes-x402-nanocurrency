# n8n-nodes-x402nano

An n8n community node package for the **x402 payment protocol** with **Nano (XNO)** — the HTTP 402 paywall for AI APIs and other web resources.

> **Status: scaffold.** Node skeletons, credentials and CI/CD are in place. The client operations and paywall trigger are being implemented.

## What it will do

### `X402 Nano` node (client — payer)

| Operation | Description |
| --- | --- |
| Pay | Wrap any HTTP request: probe, pay the 402 with Nano, retry, return the paid response + settlement metadata |
| Probe | Send a request without paying and get the payment requirements (price, payTo, resource) |
| Build Payment Signature | Create an `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2) header from payTo + amount |
| Verify Payment | Check a payment payload against an x402 facilitator |
| Settle Payment | Process a verified payment block and get the transaction hash |
| Supported | List the facilitator's supported payment kinds |
| Probe Upstream Price | Call a paywalled upstream URL, parse its v1/v2 requirements, apply a markup percentage |

### `X402 Nano Trigger` node (resource server — seller)

A webhook that turns any n8n workflow into a paid endpoint:

```
X402 Nano Trigger (request with or without payment)
├─ no payment header  → Respond 402 + PAYMENT-REQUIRED (probe)
└─ paid request       → verify + settle (facilitator or local Nano RPC)
                        → your business nodes (NanoGPT, ...)
                        → Respond 200 + PAYMENT-RESPONSE + result
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
