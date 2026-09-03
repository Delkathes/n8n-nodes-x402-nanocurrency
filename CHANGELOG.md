# Changelog

## [0.3.4](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/compare/0.3.3...0.3.4) (2026-09-03)

### Bug Fixes

* X402 Nano Trigger webhook path (n8n does not resolve {{}}) ([cd44d63](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/commit/cd44d63e3e5304daaa56371daba88d5c5a7686dc))

## [0.3.3](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/compare/0.3.2...0.3.3) (2026-09-03)

### Bug Fixes

* Build Payment Signature (header mode) echoes the full wire accept ([d030e64](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/commit/d030e641e9013610556cb3cef7905806ebc09d5d))

## [0.3.2](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/compare/0.3.1...0.3.2) (2026-09-03)

### Bug Fixes

* require base-difficulty work for payments, airtight replay match, receive-tier PoW ([0c9d8f4](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/commit/0c9d8f45c78595001ed0e18caaabe8089cff1d87))

## [0.3.1](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/compare/0.3.0...0.3.1) (2026-09-03)

### Bug Fixes

* open-block work root, modern work_validate fields, idempotent replay verification ([82645e8](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/commit/82645e81a89466c56c4edbcff79269585ce691c2))

# [0.3.0](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/compare/0.2.0...0.3.0) (2026-09-03)

### Features

* send with payment header operation, GET trigger webhook, maxTimeoutSeconds param ([ad45507](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/commit/ad455070dbf31431609cee1951817804f16b8e56))

# 0.2.0 (2026-09-03)

### Bug Fixes

* align operation parameter names and support the current NanoGPT v1 response shape ([49916bd](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/commit/49916bd4489d305eb48617d77a0e76ef3354dc30))
* x402 core compatibility — echo wire accept verbatim, accept object headers, uppercase block hex ([2f537a7](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/commit/2f537a70762909a9e444f61a09a492f3dcbc5387))

### Features

* implement the x402 payment client and paywall trigger ([0fe9430](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/commit/0fe94309376506f07b757350548a525310ebbcce))
* receive pending payments, harden local verification, unique trigger paths ([cd9cc88](https://github.com/Delkathes/n8n-nodes-x402-nanocurrency/commit/cd9cc882888dcecc1daf10e576dc9f886a610c3a))
