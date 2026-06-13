---
name: woolworths
description: Order groceries from Woolworths Dash delivery via CLI. Search, cart, checkout, and delivery management.
---

# woolworths skill

Order groceries from [Woolworths Dash](https://www.woolworths.co.za) on-demand delivery using the `woolies` CLI.

## Install

```bash
brew install yashiels/tap/woolies
```

Requires Node.js ≥ 16. The formula installs the `woolies` binary globally.

## Credentials

Authentication tokens are stored at:

```
~/.openclaw/credentials/woolworths-mobile.json
```

This file is created automatically on first login and is refreshed transparently. Never commit it — it is listed in `.gitignore`.

The JSON file may include the following optional fields to preset delivery context:

| Field | Purpose |
|-------|---------|
| `username` | Woolworths account email |
| `password` | Woolworths account password |
| `place_id` | Default delivery address `placeId` |
| `store_id` | Matching Dash store ID |
| `address_nickname` | Human label for the default address |
| `card_id` | Preferred saved card ID for checkout |
| `cvv` | CVV for the preferred card (checkout only) |

## Commands

### Search & Products

```bash
woolies search <query>
```

Search the product catalogue. No authentication required — uses the public Constructor.io search index.

---

### Cart

```bash
woolies cart
```

Show current cart contents, per-item totals, and the running cart total. Warns when the order is below the R150 minimum.

```bash
woolies add <query|sku> [qty]
```

Add an item to the cart by free-text search query or exact SKU. `qty` defaults to 1. Quantity is **additive** — running this twice adds two units.

```bash
woolies remove <name|id>
```

Remove an item from the cart by partial name match, SKU, or `commerceId` (format: `ci<digits>`).

```bash
woolies clear
```

Empty the entire cart.

```bash
woolies order <query> [qty]
```

Search-and-add shortcut: finds the top result for `<query>` and adds `[qty]` (default 1) to the cart in one step. Equivalent to `woolies search` + `woolies add`.

---

### Delivery

```bash
woolies addresses
```

List all saved delivery addresses, including their `placeId` and `storeId` values.

```bash
woolies timeslots
```

Show available delivery windows for the default address. Each slot has a human description and a numeric index used by `checkout`.

---

### Checkout

```bash
woolies checkout [index]
```

Walk the checkout flow: confirms delivery address, books the timeslot at `[index]` (or prompts when omitted), fetches the web payment session, and lists cards on file.

**The command stops before 3DS.** It never submits payment or triggers a bank-app push. After running `checkout`, you must complete payment manually in the Woolworths app or website.

---

### Orders & Auth

```bash
woolies orders
```

List past orders with status and total. Uses a best-effort history endpoint; results may be incomplete.

```bash
woolies login
```

Force a fresh Cognito authentication. Writes new tokens to `~/.openclaw/credentials/woolworths-mobile.json`. Use when the session has expired or credentials have changed.

```bash
woolies token
```

Inspect the current token state: session token prefix, expiry timestamp, refresh token presence, and the WFS API base URL.

```bash
woolies help
```

Print the full command reference.

---

## Architecture

| File | Role |
|------|------|
| `bin/woolies.js` | CLI entrypoint — argument parsing, command routing, table output |
| `lib/api-client.js` | `WoolworthsDash` class — all API calls, auth, HTTP helpers; importable as a library |
| `api-client.js` | Backward-compatibility shim → `lib/api-client.js` (deprecated, will be removed in next major) |

The library has **zero runtime dependencies** — only Node.js built-ins (`https`, `fs`, `path`, `crypto`).

## Safety Notes

- **Checkout never completes automatically.** `woolies checkout` stops before any 3DS bank-app interaction. Real money only moves after you manually approve the push notification in your bank app.
- **Credentials are local only.** Tokens live in `~/.openclaw/credentials/woolworths-mobile.json` and are never sent anywhere except directly to Woolworths' own endpoints.
- **Cart operations are additive.** `woolies add` accumulates quantity — running it multiple times increases the count. Use `woolies cart` and `woolies remove` to adjust.
