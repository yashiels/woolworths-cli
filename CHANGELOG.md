# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `AGENTS.md` — agentic development guide with repo structure, build targets, design decisions, and constraints
- `Makefile` — standard `ci`, `lint`, `test`, `fmt`, `clean` targets
- `test/smoke.test.js` — smoke tests for syntax check and CLI entrypoint
- `.prettierrc` — Prettier formatting config (singleQuote, trailingComma all, printWidth 100)

### Changed

- `package.json` scripts: `test` now runs `node test/smoke.test.js`; added `fmt` script

## [1.0.0] — 2026-06-08

### Added

- `woolies search` — product search via Constructor.io (no auth required)
- `woolies cart` — display cart contents and running total
- `woolies add` — add items by search query or SKU with optional quantity
- `woolies remove` — remove items by name substring or `commerceId`
- `woolies clear` — empty the entire cart
- `woolies order` — one-shot search-and-add shortcut
- `woolies addresses` — list saved delivery addresses with `placeId` / `storeId`
- `woolies timeslots` — show available delivery windows for the default address
- `woolies checkout` — walk the full checkout flow up to (but not through) 3DS
- `woolies orders` — list past orders
- `woolies token` — inspect Cognito token state and expiry
- `woolies login` — force a fresh Cognito authentication
- `TokenManager` — automatic IdToken refresh; falls back to full re-login on expiry
- `WoolworthsDash` — exportable Node.js client class for use as a library
- Automated release pipeline: version bump → Bun binary compilation (macOS arm64, Linux x64) → GitHub Release → Homebrew tap update
- Zero-dependency implementation using only Node.js standard library

[1.0.0]: https://github.com/yashiels/woolworths-cli/releases/tag/v1.0.0
