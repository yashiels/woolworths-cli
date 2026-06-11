# AGENTS.md — woolies

Woolworths Dash grocery CLI. Pure Node.js, zero dependencies, reverse-engineered from the Woolworths Dash Android app.

## Structure

```
woolworths-cli/
├── api-client.js          # CLI entrypoint + WoolworthsDash library class (monolith, root)
├── package.json
├── package-lock.json
├── .prettierrc
├── Makefile
├── CHANGELOG.md
├── README.md
├── LICENSE
├── version.env
├── docs/
│   └── assets/
├── test/
│   └── smoke.test.js
└── .github/
    └── workflows/
        ├── ci.yml
        ├── release-impl.yml
        └── ship.yml
```

## Build / Test / Lint

```bash
make ci        # lint + test (the standard gate before any commit)
make lint      # node --check api-client.js
make test      # node test/smoke.test.js
make fmt       # npx prettier --write .
make clean     # no-op (no compiled artifacts)
```

All commands are also available via `npm run <name>`.

## Key Design Decisions

- **Zero runtime dependencies** — standard-library only (`https`, `fs`, `path`, `crypto`). No axios, no node-fetch, no commander.
- **Full checkout flow (stops before 3DS)** — `woolies checkout` walks slot selection, shipping auth, and card listing, then stops with instructions. 3DS bank-app approval is intentionally not automated.
- **Android app reverse-engineering** — API endpoints, headers, and the `sha1password` constant were extracted from Woolworths Dash Android v10.11.0 via MITM + APK inspection.
- **Session caching** — Cognito tokens (IdToken + RefreshToken) are written to `~/.woolworths-session.json`. `TokenManager` auto-refreshes on expiry.
- **Dual-use module** — `api-client.js` exports `WoolworthsDash` for programmatic use and also drives the CLI when run directly.

## CLI Commands

| Command | Description |
|---------|-------------|
| `search <query>` | Search products via Constructor.io (no auth) |
| `cart` | Display cart contents and running total |
| `add <query\|sku> [qty]` | Add item to cart by search query or SKU |
| `remove <query\|name\|commerceId>` | Remove item from cart |
| `clear` | Empty the entire cart |
| `order <query> [qty]` | One-shot search-and-add shortcut |
| `addresses` | List saved delivery addresses |
| `timeslots` | Show available delivery windows for default address |
| `checkout` | Full checkout flow (stops before 3DS) |
| `orders` | List past orders |
| `token` | Inspect Cognito token state and expiry |
| `login` | Force a fresh Cognito authentication |

Pass `--json` to most commands for machine-readable output.

## Constraints for Agents

- **No npm runtime deps** — do not introduce runtime dependencies. Dev-only tooling (prettier, etc.) is fine.
- **Do not complete 3DS programmatically** — the checkout flow must stop before any bank-app interaction.
- **Keep `--json` output stable** — downstream tools rely on the JSON shape; breaking changes require a semver bump and CHANGELOG entry.
- **`api-client.js` is at root** — a restructure into `bin/` + `lib/` is planned separately (see GitHub issue). Do not move files in this PR/branch.
- **Node ≥ 16** — the engines field is `"node": ">=16"`. Do not use Node APIs unavailable on 16.

## CI

Workflows live in `.github/workflows/`:

- `ci.yml` — runs on push/PR; executes `make ci`
- `ship.yml` — release pipeline (version bump → binaries → GitHub Release → Homebrew tap)
- `release-impl.yml` — implementation detail for the release pipeline

Run locally: `make ci`
