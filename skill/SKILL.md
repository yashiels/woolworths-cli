---
name: woolworths
description: Order groceries from Woolworths Dash delivery via CLI. Search, cart, book a delivery slot, and walk checkout up to the 3DS bank-approval step.
---

# woolworths skill

Order groceries from [Woolworths Dash](https://www.woolworths.co.za) on-demand delivery using the `woolies` CLI. Talks directly to the private Woolworths Dash / WFS APIs (reverse-engineered from the Android app); no browser required.

## Install

```bash
brew install yashiels/tap/woolies
```

Requires Node.js ≥ 16. The formula installs the `woolies` binary globally and auto-taps `yashiels/tap` on first install. Zero runtime dependencies (Node standard library only).

## Credentials

`woolies` reads a single JSON credentials file:

```
~/.openclaw/credentials/woolworths-mobile.json
```

Auth is **email + password** (AWS Cognito `USER_PASSWORD_AUTH`) — **not** OTP. Unlike some sibling CLIs, `woolies` never prompts interactively: it reads `email` and `password` straight from this file. Seed those two fields once, then `woolies login` exchanges them for a Cognito IdToken (24 h) + RefreshToken (long-lived), which are written back into the same file and refreshed transparently. `woolies login` throws `Missing email/password in <path>` if the file has no `email`/`password`.

Minimum file to create before first login:

```json
{
  "email": "you@example.com",
  "password": "your-woolies-password"
}
```

| Field | Managed by | Purpose |
|-------|------------|---------|
| `email` | you (required) | Woolworths account email — used as the Cognito username |
| `password` | you (required) | Woolworths account password |
| `session_token` | CLI | Cognito IdToken (24 h); auto-refreshed |
| `refresh_token` | CLI | Cognito RefreshToken; used for silent refresh |
| `dyn_user_id` | CLI | Derived from the IdToken (`custom:AtgId`) |
| `place_id` | optional | Default delivery address `placeId` (else discovered from default address) |
| `store_id` | optional | Matching Dash store ID |
| `address_nickname` | optional | Human label for the default address |
| `card_id` | optional | Preferred saved card ID for checkout |
| `cvv` | optional | CVV for the preferred card (stored locally only) |
| `driver_tip` | optional | Driver tip in Rands (default `0`) |
| `api_base` | optional | Override the WFS API base URL |

The file is written `chmod 0600` and is git-ignored. Tokens live locally and are sent only to Woolworths' own endpoints. There is **no environment-variable credential support** — the JSON file is the only source.

## Auth commands

| Command | Description |
|---|---|
| `woolies login` | Force a fresh Cognito login using `email`/`password` from the creds file; writes new tokens |
| `woolies token` | Inspect token state: session-token prefix, expiry, refresh-token presence, dyn_user_id, WFS base URL |

## Search & products

| Command | Description |
|---|---|
| `woolies search <query>` | Search the catalogue via Constructor.io. **No auth required** — public search index |

## Cart commands

| Command | Description |
|---|---|
| `woolies cart` | Show cart contents, per-item totals, running total; warns below the R150 minimum |
| `woolies add <query\|sku> [qty]` | Add an item by free-text query or exact SKU. `qty` defaults to 1. **Quantity is additive** — running twice adds two units |
| `woolies remove <query\|name\|ciId>` | Remove by partial name match, SKU, or `commerceId` (format `ci<digits>`) |
| `woolies clear` | Empty the entire cart |
| `woolies order <query> [qty]` | Shortcut: search for `<query>`, add the top result (`qty` default 1) in one step |

## Delivery commands

| Command | Description |
|---|---|
| `woolies addresses` | List saved delivery addresses, including their `placeId` / `storeId` |
| `woolies timeslots` | Show available delivery windows for the default address; each slot has a 0-based index used by `checkout` |

## Checkout & orders

| Command | Description |
|---|---|
| `woolies checkout [slotIndex]` | Walk the checkout flow: confirm address, book the timeslot at `[slotIndex]` (last slot if omitted), fetch the web payment session, list cards on file. **Stops before 3DS** — never charges |
| `woolies orders` | List past orders with status and total (best-effort history endpoint; may be incomplete) |

**Checkout never completes a payment.** `woolies checkout` walks up to slot booking, shipping auth, and card listing, then stops and prints the manual next steps. There is no `--confirm` flag; the final place-order / 3DS bank-app approval is intentionally not automated. Real money only moves when you approve the push in your bank app manually.

## Headless / agent usage

Woolworths uses **email + password** stored in a file — there is **no OTP/SMS step and no interactive prompt**, which makes it fully unattended once seeded:

- **Seed credentials once:** write `{ "email": ..., "password": ... }` into `~/.openclaw/credentials/woolworths-mobile.json`. After that, every command — including `woolies login` — runs headless with no TTY. There is no interactive re-login to guard against, because `login` only ever reads the file.
- **If the file is missing `email`/`password`,** any authed command surfaces `Missing email/password in ~/.openclaw/credentials/woolworths-mobile.json`. Surface that to the user and ask them to seed or fix the file — do **not** retry or fabricate credentials.
- **Tokens self-heal.** Commands call the token manager, which refreshes via `REFRESH_TOKEN_AUTH` when the IdToken is near expiry and falls back to a full `login` (re-reading email/password) if the refresh token has expired. You rarely need to call `woolies login` explicitly.
- **Reads are safe to run unattended:** `search`, `cart`, `addresses`, `timeslots`, `orders`, `token`. `search` needs no login at all.
- **Checkout is confirm-gated.** `woolies checkout` books a real delivery slot as a side effect (though it never pays). Only run it after the user has explicitly approved the cart and slot. It always stops before 3DS, so no charge can occur from the CLI — payment must be completed by the user in the Woolworths/bank app.

Note: this CLI has **no `--json` flag** — output is human-readable text only. Parse the printed tables if you need structured values.

## Typical flow

```bash
# 0. One-time: seed email + password into the creds file
#    ~/.openclaw/credentials/woolworths-mobile.json → { "email": "...", "password": "..." }
woolies login                       # exchange them for Cognito tokens

# 1. Find and add items (add is additive)
woolies search "coconut water"
woolies add "full cream milk" 2
woolies add 6009204330856 1
woolies order "brown bread"         # search + add top result in one step

# 2. Review cart and delivery options
woolies cart
woolies addresses
woolies timeslots

# 3. Walk checkout (stops before 3DS — approve payment on your bank app)
woolies checkout                    # last slot, or pass a slot index: woolies checkout 2

# 4. Review orders afterwards
woolies orders
```

## Notes

- Checkout never completes automatically — it hands off before any bank-app interaction.
- Cart operations are additive: `woolies add` accumulates quantity. Use `woolies cart` / `woolies remove` to adjust.
- `woolies token` is the quickest way to check whether the session is valid before a run.
- The CLI exits non-zero and prints a human-readable error to stderr on API failure.
