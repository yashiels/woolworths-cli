# woolworths-cli

A command-line client and Node.js module for **Woolworths Dash** — Woolworths South Africa's
on-demand grocery delivery service. Search the catalogue, build a cart, manage saved
addresses and delivery slots, and walk the checkout flow right up to payment.

Pure Node.js — **no dependencies**, just the standard library. It speaks the same API the
Woolworths Dash Android app does, reverse-engineered from MITM captures of **app v10.11.0**.

```bash
$ woolies search "coconut water"
Searching: "coconut water"

  #  Product                                   Price     SKU
  1  100 % Coconut Water 1 L                   R73.99    6009204330856
  2  100 % Coconut Water 330 ml                R32.99    6009204330863
  ...
```

> ⚠️ **Unofficial.** This is not affiliated with or endorsed by Woolworths. It mimics the
> private mobile API, which can change or break without notice. Use it with your own account,
> at your own risk.

---

## Installation

Requires **Node.js ≥ 16** (uses `crypto.randomUUID` and `URLSearchParams`).

### Global install

```bash
npm install -g woolworths-cli
woolies search "milk"
```

### From source

```bash
git clone https://github.com/yashiels/woolworths-cli.git
cd woolworths-cli
npm link          # symlinks the `woolies` binary onto your PATH
# or just run it directly:
node api-client.js search "milk"
```

There is nothing to build and nothing to `npm install` — the only dependency is Node itself.

---

## Setup

### 1. Create a credentials file

The client reads credentials from `~/.openclaw/credentials/woolworths-mobile.json`. Create it
with your Woolworths account login:

```json
{
  "email": "you@example.com",
  "password": "your-woolies-password"
}
```

That is the **minimum** — everything else is discovered automatically (see below). The file is
written back with `0600` permissions and the tokens are merged in after your first login.

> 🔒 **Never commit this file.** It lives outside the repo by default, and `.gitignore` blocks
> `credentials/`, `*.creds.json`, `woolworths-mobile.json`, and `.env*` for good measure.

### 2. Log in

```bash
woolies login
```

This performs a Cognito `USER_PASSWORD_AUTH` login and stores the resulting `session_token`
(IdToken, ~24h) and `refresh_token` (lasts months) back into the credentials file. From then on
the client auto-refreshes — you should rarely need to run `login` again.

### 3. Your IDs are discovered for you

You do **not** have to hunt down internal identifiers manually:

| Field | How it's obtained |
|-------|-------------------|
| `dyn_user_id` | Decoded from the JWT `custom:AtgId` claim on login |
| `place_id` / `store_id` / `address_nickname` | Resolved from your default saved address — run `woolies addresses` to see them |

If you want to pin a specific delivery address (instead of letting it default), or pre-fill
payment details for future automation, you can add any of these optional fields to the
credentials file:

```json
{
  "email": "you@example.com",
  "password": "your-woolies-password",
  "place_id": "ChIJ...",
  "store_id": "...",
  "address_nickname": "Home",
  "card_id": "usercc...",
  "cvv": "123",
  "driver_tip": 0,
  "api_base": "https://wfs-appserver.wigroup.co/wfs/app/v4"
}
```

`sha1password` is an **APK-level constant** baked into the client (it is the same for every
user — it is *not* derived from your password), so you don't need to supply it. You can override
it in creds if Woolworths ever rotates it.

---

## CLI commands

All commands assume the global `woolies` binary. If you're running from source, substitute
`node api-client.js`.

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

> **Quantities are additive.** `woolies add "milk" 2` run twice leaves **4** in the cart, not 2.
> This mirrors the underlying API (see [Gotchas](#gotchas)). Use the cart view to check totals.

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

`checkout` confirms your location, picks a delivery slot, submits shipping details, and lists the
cards on file — then **stops** at 3DS. See [The 3DS payment caveat](#the-3ds-payment-caveat).

---

## Module API

The same client is importable. Everything is `async`.

```javascript
const { WoolworthsDash } = require('woolworths-cli');
// or, from source: require('./api-client')

const woolies = new WoolworthsDash();

// Search (Constructor.io, no auth) → [{ sku, name, price, image }]
const results = await woolies.searchProducts('coconut water', { limit: 10 });

// Cart → { items, total, count, raw }
const cart = await woolies.getCart();

// Add items — quantity is ADDITIVE
await woolies.addItems([
  { sku: '6009204330856', quantity: 2 },
  { sku: '6009204330863', quantity: 1, substitution: 'SHOPPER_CHOICE' },
]);

// Set an absolute quantity, or remove, by commerceId (the cart item id, e.g. "ci2115702714")
await woolies.setItemQuantity('ci2115702714', 3);
await woolies.removeItem('ci2115702714');
await woolies.clearCart();

// Delivery context
const addresses = await woolies.getAddresses();
const { slots, ctx } = await woolies.confirmLocation();   // resolves your default address

// Checkout up to (but not through) 3DS
const flow = await woolies.walkCheckout({ slotIndex: null }); // null = last available slot
// → { ready, cart, ctx, slot, jsessionId, auth, cards, message }

// Orders (best-effort)
const { orders } = await woolies.getOrders();
```

Lower-level pieces are exported too:

```javascript
const { WoolworthsDash, TokenManager, CONFIG, decodeJwt } = require('woolworths-cli');

const tokens = new TokenManager();
await tokens.login();              // USER_PASSWORD_AUTH → IdToken + RefreshToken
await tokens.refresh();            // REFRESH_TOKEN_AUTH (falls back to login)
const jwt = await tokens.getSessionToken();
```

### Ordering flow

The full checkout sequence the client follows:

1. `searchProducts(query)` → SKUs + prices (Rands, e.g. `73.99`)
2. `addItems([{ sku, quantity }])` → adds to the WFS cart (additive)
3. `getCart()` → normalized items, total, count
4. `confirmLocation()` → confirms delivery address, returns timeslots
5. `setShipping({ ..., slot })` → selects a slot, returns web-payment cookies (`jsessionId` + `auth`)
6. `getWebCards(jsessionId, auth)` → lists saved cards
7. **3DS payment** → approve the push on your bank app *(manual — not automated)*

`walkCheckout()` runs steps 1–6 for you and stops at step 7.

**Minimum order value: R150** (cart total). The `cart` command warns when you're below it.

---

## Architecture

Woolworths Dash is not one API — the app stitches together several backends. This client talks to
all of them and hides the differences behind one interface.

| Surface | Base URL | Auth |
|---------|----------|------|
| **Cognito** | `cognito-idp.eu-west-1.amazonaws.com` | App client ID; `USER_PASSWORD_AUTH` → JWT |
| **WFS** (cart, checkout, products) | `wfs-appserver.wigroup.co/wfs/app/v4` | `Sessiontoken` JWT + SHA1 + device headers |
| **Constructor.io** (search) | `wpkmgeuco-zone.cnstrc.com` | Public key, no auth |
| **Web payment** (cards, 3DS) | `www.woolworths.co.za/server` | Cookies from the shipping-details response |

### Authentication

```
email + password
      │
      ▼  Cognito InitiateAuth (USER_PASSWORD_AUTH)
IdToken (JWT, ~24h)  ── used as the `Sessiontoken` header on every WFS call
RefreshToken (months) ── used to silently mint new IdTokens
      │
JWT claim custom:AtgId → dyn_user_id (another required WFS header)
```

The `TokenManager` loads tokens from the credentials file, refreshes them when they're within a
minute of expiry, and falls back to a full login if the refresh token is rejected. WFS calls that
return `401` are retried once with a freshly refreshed token.

### Required WFS headers

Every WFS call sends a native-app header set. The notable ones:

```
Content-Type:  application/json        ← required even on GET (see Gotchas)
Sessiontoken:  <cognito IdToken>
Dyn_user_id:   <from JWT custom:AtgId>
Sha1password:  <APK-level constant, same for everyone>
Apiid: ANDROID_V10.11 | Os: Android | Appversion: 10.11.0 | Iscognito: true
Devicemodel: SM-S928B | User-Agent: okhttp/4.12.0
```

---

## Gotchas

Hard-won quirks of the Woolworths API, all handled by the client:

1. **`Content-Type` is required on GET.** WFS rejects GET requests without
   `Content-Type: application/json`. The client uses `https.request()` (not `fetch`) so it can set
   the header on every method.
2. **Adding to the cart is additive.** `POST /cart/OnDemand/itemV2` *adds* to the existing
   quantity. To set an absolute quantity, use `setItemQuantity()` (`PUT /cartV2/item/{commerceId}`).
3. **Cart ops use `commerceId`, not the SKU.** Updating or removing an item needs
   `commerceItemInfo.id` (e.g. `ci2115702714`), not the catalogue SKU/`catalogRefId`.
4. **`placesId` vs `placeId`.** The saved-addresses response uses `placesId` (with an *s*); every
   other endpoint uses `placeId`. The client normalizes both.
5. **The `Dash` search filter is dead.** `filters[visibility]=Dash` returns zero results; search
   is unfiltered.
6. **`Sha1password` is an APK constant.** It's hardcoded into the app and shared by all users —
   *not* derived from your password.
7. **Payment switches to the web API.** The `/server/*` payment endpoints authenticate with the
   `TOKEN` + `AUTHENTICATION` cookies returned by `shippingDetails`, not the `Sessiontoken` header.

### Known limitations

- **`orders`** uses an unverified history endpoint and parses defensively — treat it as best-effort.
- **Product detail** field parsing is best-effort across response shapes.
- Slot-time parsing assumes the app's `hourFrom` format (e.g. `9am`, `5pm`).
- The API is private and undocumented; an app update can change endpoints or headers at any time.

---

## The 3DS payment caveat

**Payment cannot be fully automated, by design.** Woolworths runs card payments through **3-D
Secure (3DS)**, which sends a push notification to your bank's app that *you* must approve on your
phone. There is no API path around it.

So `checkout` / `walkCheckout()` deliberately stops one step short. It will:

- ✅ confirm your delivery location and list timeslots,
- ✅ select a slot and submit shipping details,
- ✅ obtain the web-payment auth (`jsessionId` + `auth`),
- ✅ list the cards on file,

…and then hand back to you with instructions. The remaining manual steps are:

```
select card → submit CVV → approve the 3DS push on your bank app
   → POST /cart/checkoutComplete → GET /cart/checkout/submittedOrder
```

This is intentional: it keeps the irreversible "money leaves your account" action behind a human
approval you have to make on your phone anyway.

---

## License

[MIT](./LICENSE) © Yashiel Sookdeo
