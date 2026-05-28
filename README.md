# woolies — Woolworths Dash grocery delivery from your shell

CLI and Node.js client for Woolworths Dash — South Africa's on-demand grocery delivery. Pure Node.js, zero dependencies, speaks the same API the Dash Android app does.

- **No dependencies** — pure Node.js standard library
- **Full checkout flow** — cart, delivery slots, shipping, saved cards; stops before 3DS by design
- **Auto token refresh** — Cognito IdToken + RefreshToken managed transparently

## Install

```bash
brew install yashiels/tap/woolies  # auto-taps yashiels/tap
```

Direct downloads from the [latest GitHub release](https://github.com/yashiels/woolworths-cli/releases/latest).

Build from source:

```bash
git clone https://github.com/yashiels/woolworths-cli.git
cd woolworths-cli
npm install
```

## Quick Start

```bash
woolies login                  # Cognito auth → stores tokens
woolies search "coconut water"
woolies add "full cream milk" 2
woolies cart
woolies timeslots
woolies checkout               # walk to 3DS step (manual bank approval)
```

## Commands

All commands assume the global `woolies` binary. If you're running from source, substitute `node api-client.js`.

### Search & products

```bash
woolies search "coconut water"      # search the catalogue (Constructor.io, no auth)
```

### Cart

```bash
woolies cart                        # show cart contents + total
woolies add "full cream milk" 2     # add by search query (first match), qty 2
woolies add 6009204330856 3         # add by SKU, qty 3
woolies remove "milk"               # remove by name substring
woolies remove ci2115702714         # remove by commerceId
woolies clear                       # empty the entire cart
woolies order "brown bread" 1       # quick order: search + add in one step
```

### Account & delivery

```bash
woolies addresses                   # list saved delivery addresses (with placeId/storeId)
woolies timeslots                   # show available delivery slots for your address
woolies token                       # show current token state + expiry
woolies login                       # force a fresh Cognito login
```

### Checkout & orders

```bash
woolies checkout                    # walk checkout to the 3DS payment step (last slot)
woolies checkout 0                  # ...using slot index 0 (see `timeslots`)
woolies orders                      # list past orders (best-effort)
```

## Configuration

Credentials file: `~/.openclaw/credentials/woolworths-mobile.json`

```json
{
  "email": "you@example.com",
  "password": "your-woolies-password"
}
```

Optional fields: `place_id`, `store_id`, `address_nickname`, `card_id`, `cvv`, `driver_tip`, `api_base`.

IDs are discovered automatically after login: `dyn_user_id` from JWT, `place_id` / `store_id` from your default saved address.

Payment cannot be fully automated — Woolworths uses 3-D Secure, requiring a push notification approval on your bank's app. `checkout` stops one step short intentionally.

## Disclaimer

Not affiliated with Woolworths South Africa. Talks to private, undocumented APIs reverse-engineered from the Woolworths Dash Android app (v10.11.0). Use at your own risk.

## Development

```bash
npm install     # install dependencies
```

Releases are automated via GitHub Actions. Go to **Actions → Ship**, pick `patch`, `minor`, or `major` — it bumps the version, builds a standalone binary, publishes a GitHub release, and updates the [Homebrew tap](https://github.com/yashiels/homebrew-tap).

## License

MIT — Yashiel Sookdeo
