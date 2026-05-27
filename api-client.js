#!/usr/bin/env node
/**
 * Woolworths Dash API Client (MITM-verified, 2026)
 *
 * Pure API client reverse-engineered from the Woolworths Dash Android app v10.11.0.
 * Modeled on the Checkers Sixty60 client; serves as both a CLI and an importable module.
 *
 * Services:
 *  - Cognito (cognito-idp.eu-west-1.amazonaws.com) — USER_PASSWORD_AUTH → IdToken (24h) + RefreshToken
 *  - WFS (wfs-appserver.wigroup.co/wfs/app/v4) — products, cart, checkout. Needs special headers.
 *  - Constructor.io (wpkmgeuco-zone.cnstrc.com) — product search (public key, no auth)
 *  - Web payment (www.woolworths.co.za/server) — cards/3DS via cookies from shippingDetails
 *
 * Gotchas handled (see README.md):
 *  1. WFS rejects GET without `Content-Type: application/json` → we use https.request(), always set it.
 *  2. `POST /cart/OnDemand/itemV2` is ADDITIVE; `PUT /cartV2/item/{commerceId}` is absolute.
 *  3. Cart ops use `commerceItemInfo.id` (e.g. ci2115702714), NOT the SKU/catalogRefId.
 *  4. Addresses use `placesId` (with s); every other endpoint uses `placeId`.
 *  5. Search filter `filters[visibility]=Dash` is dead → use unfiltered.
 *  6. Sha1password is an APK-level constant, the same for everyone (not per-user).
 *  7. Payment switches to web /server/* cookies (TOKEN + AUTHENTICATION), not the Sessiontoken header.
 *
 * 3DS is intentionally NOT automated — it requires bank-app approval. `checkout` walks up to
 * that point (slot + shipping auth + card list) and then stops with instructions.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG = {
  // Service hosts
  COGNITO_URL: 'https://cognito-idp.eu-west-1.amazonaws.com/',
  COGNITO_CLIENT_ID: 'kncqim4s1upf5ktp7lt6j3cvr',
  WFS_BASE: 'https://wfs-appserver.wigroup.co/wfs/app/v4',  // overridable via creds.api_base
  CONSTRUCTOR_BASE: 'https://wpkmgeuco-zone.cnstrc.com',
  CONSTRUCTOR_KEY: 'key_tw9hKe0fkfgEf36D',
  WEB_BASE: 'https://www.woolworths.co.za',

  // App identity (WFS native headers)
  APIID: 'ANDROID_V10.11',
  OS: 'Android',
  OS_VERSION: '34',
  APP_VERSION: '10.11.0',
  DEVICE_VERSION: 'samsung',
  DEVICE_MODEL: 'SM-S928B',
  USER_AGENT: 'okhttp/4.12.0',
  WEB_USER_AGENT: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36',

  // APK-level SHA1 constant (same for everyone — see gotcha #6). Overridable via creds.
  SHA1_PASSWORD: '42058a7d46a6191bd3a5e0e792e1b1d5cc7638aa',

  // Per-user delivery context (populated from creds when present, else discovered from addresses)
  PLACE_ID: '',
  STORE_ID: '',
  ADDRESS_NICKNAME: '',
  CARD_ID: '',
  CVV: '',
  DRIVER_TIP: 0,
  APP_INSTANCE_ID: 'dJOO0vnMRRy9o1CyMwwZpR',  // app constant; overridable via creds

  MIN_ORDER: 150,  // Dash minimum order value (Rands)

  // Credentials path
  CREDS_PATH: path.join(process.env.HOME, '.openclaw/credentials/woolworths-mobile.json'),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Decode a JWT payload (base64url) without verifying the signature. */
function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return null; }
}

/** Format a Rand amount for display. Woolworths prices are in Rands (not cents). */
function fmtR(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return 'N/A';
  return `R${Number(n).toFixed(2)}`;
}

/** Pad/truncate a string to a fixed width for simple table output. */
function pad(s, w) {
  s = String(s == null ? '' : s);
  if (s.length > w) return s.slice(0, w - 1) + '…';
  return s.padEnd(w);
}

/**
 * Normalize a Constructor.io product into { sku, name, price }.
 * Handles both the search shape (response.results[]) and the autocomplete shape (sections.Products[]).
 */
function normalizeConstructorItem(item) {
  const d = item.data || {};
  const sku = d.id || item.id || d.catalogRefId || null;
  const name = item.value || d.name || d.productDisplayName || (sku ? String(sku) : '?');
  let price = d.price;
  if (price == null) price = d.p10;
  if (price == null) price = d.salePrice;
  if (price == null) price = d.list_price;
  if (typeof price === 'string') price = parseFloat(price);
  return {
    sku: sku ? String(sku) : null,
    name,
    price: (price == null || isNaN(price)) ? null : Number(price),
    image: d.image_url || d.imageUrl || null,
    raw: item,
  };
}

/** HTTP request helper (uses https.request so we can set Content-Type on GET — WFS quirk). */
function request(method, url, { headers = {}, body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const finalHeaders = { ...headers };

    // Default User-Agent only if the caller didn't set one (case-insensitive).
    if (!Object.keys(finalHeaders).some(k => k.toLowerCase() === 'user-agent')) {
      finalHeaders['User-Agent'] = CONFIG.USER_AGENT;
    }

    let bodyStr;
    if (body !== null && body !== undefined) {
      bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      if (!Object.keys(finalHeaders).some(k => k.toLowerCase() === 'content-type')) {
        finalHeaders['Content-Type'] = 'application/json';
      }
      finalHeaders['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }

    const options = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers: finalHeaders,
      timeout,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, headers: res.headers, data: body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Token Manager ───────────────────────────────────────────────────────────
class TokenManager {
  constructor() {
    this.email = null;
    this.password = null;
    this.sessionToken = null;     // Cognito IdToken — used as the Sessiontoken header
    this.refreshToken = null;     // Cognito RefreshToken — lasts months
    this.sessionExpiry = 0;       // ms epoch, derived from the JWT `exp` claim
    this.dynUserId = '';          // from JWT `custom:AtgId`
    this.sha1password = CONFIG.SHA1_PASSWORD;
    this.raw = {};                // full creds file, for extra per-user fields
    this._loadCredentials();
  }

  _loadCredentials() {
    try {
      if (!fs.existsSync(CONFIG.CREDS_PATH)) return;
      const c = JSON.parse(fs.readFileSync(CONFIG.CREDS_PATH, 'utf8'));
      this.raw = c;
      this.email = c.email || null;
      this.password = c.password || null;
      this.sessionToken = c.session_token || null;
      this.refreshToken = c.refresh_token || null;
      this.dynUserId = c.dyn_user_id || '';
      if (c.sha1password) this.sha1password = c.sha1password;
      if (c.api_base) CONFIG.WFS_BASE = c.api_base;

      // Per-user delivery context (optional)
      if (c.place_id) CONFIG.PLACE_ID = c.place_id;
      if (c.store_id) CONFIG.STORE_ID = c.store_id;
      if (c.address_nickname) CONFIG.ADDRESS_NICKNAME = c.address_nickname;
      if (c.card_id) CONFIG.CARD_ID = c.card_id;
      if (c.cvv) CONFIG.CVV = String(c.cvv);
      if (c.driver_tip != null) CONFIG.DRIVER_TIP = Number(c.driver_tip);
      if (c.app_instance_id) CONFIG.APP_INSTANCE_ID = c.app_instance_id;

      // Derive expiry + dyn_user_id from the stored token if we have one.
      if (this.sessionToken) this._applyIdToken(this.sessionToken);
    } catch (e) {
      console.error('Failed to load credentials:', e.message);
    }
  }

  _saveCredentials() {
    try {
      // Merge with existing creds to preserve fields we don't manage.
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(CONFIG.CREDS_PATH, 'utf8')); } catch {}
      const creds = {
        ...existing,
        email: this.email,
        password: this.password,
        sha1password: this.sha1password,
        dyn_user_id: this.dynUserId,
        session_token: this.sessionToken,
        refresh_token: this.refreshToken,
        api_base: CONFIG.WFS_BASE,
        updated_at: new Date().toISOString(),
      };
      const dir = path.dirname(CONFIG.CREDS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG.CREDS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
      this.raw = creds;
    } catch (e) {
      console.error('Failed to save credentials:', e.message);
    }
  }

  /** Apply an IdToken: decode dyn_user_id (custom:AtgId) and expiry. */
  _applyIdToken(idToken) {
    const claims = decodeJwt(idToken);
    if (!claims) return;
    if (claims['custom:AtgId']) this.dynUserId = String(claims['custom:AtgId']);
    if (claims.exp) this.sessionExpiry = claims.exp * 1000;
  }

  /** Low-level Cognito InitiateAuth call. */
  async _cognito(flow, params) {
    return request('POST', CONFIG.COGNITO_URL, {
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: { AuthFlow: flow, ClientId: CONFIG.COGNITO_CLIENT_ID, AuthParameters: params },
    });
  }

  /** Full login via USER_PASSWORD_AUTH → IdToken + RefreshToken. */
  async login() {
    if (!this.email || !this.password) {
      throw new Error(`Missing email/password in ${CONFIG.CREDS_PATH}`);
    }
    const res = await this._cognito('USER_PASSWORD_AUTH', {
      USERNAME: this.email,
      PASSWORD: this.password,
    });
    const auth = res.data && res.data.AuthenticationResult;
    if (!auth || !auth.IdToken) {
      throw new Error(`Login failed: ${JSON.stringify(res.data)}`);
    }
    this.sessionToken = auth.IdToken;
    if (auth.RefreshToken) this.refreshToken = auth.RefreshToken;
    this._applyIdToken(auth.IdToken);
    this._saveCredentials();
    return this.sessionToken;
  }

  /** Refresh via REFRESH_TOKEN_AUTH (no password). Falls back to full login if it fails. */
  async refresh() {
    if (!this.refreshToken) return this.login();
    try {
      const res = await this._cognito('REFRESH_TOKEN_AUTH', { REFRESH_TOKEN: this.refreshToken });
      const auth = res.data && res.data.AuthenticationResult;
      if (auth && auth.IdToken) {
        this.sessionToken = auth.IdToken;
        // REFRESH_TOKEN_AUTH does not return a new RefreshToken — keep the existing one.
        this._applyIdToken(auth.IdToken);
        this._saveCredentials();
        return this.sessionToken;
      }
    } catch (e) {
      console.error('Token refresh failed, falling back to full login:', e.message);
    }
    return this.login();
  }

  /** Get a valid Sessiontoken, refreshing/logging in as needed. */
  async getSessionToken() {
    if (this.sessionToken && this.sessionExpiry && Date.now() < this.sessionExpiry - 60000) {
      return this.sessionToken;
    }
    if (this.refreshToken) return this.refresh();
    return this.login();
  }

  /** WFS native headers. Content-Type is always set (required even on GET — gotcha #1). */
  nativeHeaders(token) {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Media-Type': 'application/json',
      'Sessiontoken': token || this.sessionToken,
      'Apiid': CONFIG.APIID,
      'Sha1password': this.sha1password,
      'Dyn_user_id': this.dynUserId,
      'Os': CONFIG.OS,
      'Osversion': CONFIG.OS_VERSION,
      'Appversion': CONFIG.APP_VERSION,
      'Iscognito': 'true',
      'Deviceversion': CONFIG.DEVICE_VERSION,
      'Devicemodel': CONFIG.DEVICE_MODEL,
      'Network': 'Unavailable',
      'User-Agent': CONFIG.USER_AGENT,
    };
  }

  /** Web payment headers (cookies come from the shippingDetails response — gotcha #7). */
  webHeaders(jsessionId, auth) {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Cookie': `TOKEN=${jsessionId}; AUTHENTICATION=${auth}`,
      'x-requested-by': 'Woolworths Online',
      'iscognito': 'true',
      'Origin': CONFIG.WEB_BASE,
      'Referer': `${CONFIG.WEB_BASE}/check-out/oneapp-payment?isCognito=true`,
      'User-Agent': CONFIG.WEB_USER_AGENT,
    };
  }
}

// ─── Woolworths Dash Client ──────────────────────────────────────────────────
class WoolworthsDash {
  constructor() {
    this.tokens = new TokenManager();
    this._clientId = null;
  }

  // ── Internal: WFS request with auto-refresh on 401 ─────────────────────────
  async _wfs(method, pathOrUrl, { body = null, query = null } = {}) {
    const token = await this.tokens.getSessionToken();
    let url = pathOrUrl.startsWith('http') ? pathOrUrl : CONFIG.WFS_BASE + pathOrUrl;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      url += (url.includes('?') ? '&' : '?') + qs;
    }
    let res = await request(method, url, { headers: this.tokens.nativeHeaders(token), body });
    if (res.status === 401) {
      const fresh = await this.tokens.refresh();
      res = await request(method, url, { headers: this.tokens.nativeHeaders(fresh), body });
    }
    return res;
  }

  // ── Product Search (Constructor.io — no auth) ──────────────────────────────

  /**
   * Search products. Tries the search endpoint first, falls back to autocomplete.
   * @param {string} query
   * @param {object} opts - { limit }
   * @returns {Array<{sku,name,price,image}>}
   */
  async searchProducts(query, { limit = 20 } = {}) {
    let items = await this._constructorSearch(query, limit);
    if (!items.length) items = await this._constructorAutocomplete(query, limit);
    return items;
  }

  async _constructorSearch(query, limit) {
    const qs = new URLSearchParams({
      key: CONFIG.CONSTRUCTOR_KEY,
      num_results_per_page: String(limit),
      c: 'cli-1.0',
      i: this._cnstrcClientId(),
      s: '1',
      _dt: String(Date.now()),
    });
    const url = `${CONFIG.CONSTRUCTOR_BASE}/search/${encodeURIComponent(query)}?${qs}`;
    try {
      const res = await request('GET', url, { headers: { 'Accept': 'application/json' } });
      const results = (res.data && res.data.response && res.data.response.results) || [];
      return results.map(normalizeConstructorItem).filter(p => p.sku);
    } catch {
      return [];
    }
  }

  async _constructorAutocomplete(query, limit) {
    const qs = new URLSearchParams({
      key: CONFIG.CONSTRUCTOR_KEY,
      num_results_Products: String(limit),
    });
    const url = `${CONFIG.CONSTRUCTOR_BASE}/autocomplete/${encodeURIComponent(query)}?${qs}`;
    const res = await request('GET', url, { headers: { 'Accept': 'application/json' } });
    const products = (res.data && res.data.sections && res.data.sections.Products) || [];
    return products.map(normalizeConstructorItem).filter(p => p.sku);
  }

  _cnstrcClientId() {
    if (!this._clientId) {
      this._clientId = (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString('hex');
    }
    return this._clientId;
  }

  /** Product detail by SKU (best-effort field parsing). */
  async productDetail(sku) {
    const res = await this._wfs('GET', `/productsV2/${encodeURIComponent(sku)}`, {
      query: { sku: String(sku), deliveryType: 'OnDemand' },
    });
    const d = (res.data && (res.data.product || res.data.data || res.data)) || {};
    return {
      sku: String(sku),
      name: d.productDisplayName || d.displayName || d.name || String(sku),
      price: d.price != null ? Number(d.price) : (d.salePrice != null ? Number(d.salePrice) : null),
      raw: res.data,
    };
  }

  // ── Cart (WFS) ─────────────────────────────────────────────────────────────

  /**
   * Get the current cart, normalized.
   * @returns {{ items: Array, total: number, count: number, raw: object }}
   */
  async getCart() {
    const res = await this._wfs('GET', '/cartV2');
    const cart = (res.data && Array.isArray(res.data.data) && res.data.data[0]) || null;
    const items = [];
    if (cart && cart.items && typeof cart.items === 'object') {
      // Collect every commerce-item array (foodCommerceItem, generalCommerceItem, …).
      for (const val of Object.values(cart.items)) {
        if (!Array.isArray(val)) continue;
        for (const ci of val) {
          const info = (ci && ci.commerceItemInfo) || null;
          if (!info) continue;
          items.push({
            commerceId: info.id,
            sku: info.catalogRefId,
            name: info.productDisplayName,
            quantity: info.quantity,
            price: info.price != null ? Number(info.price)
                 : info.salePrice != null ? Number(info.salePrice) : null,
            raw: ci,
          });
        }
      }
    }
    const summary = (cart && cart.orderSummary) || {};
    return {
      items,
      total: summary.total != null ? Number(summary.total) : null,
      count: summary.totalItemsCount != null ? Number(summary.totalItemsCount) : items.length,
      raw: res.data,
    };
  }

  /**
   * Add items to the cart. NOTE: quantity is ADDITIVE (gotcha #2).
   * @param {Array<{sku, quantity, substitution?}>} items
   */
  async addItems(items) {
    const body = items.map(i => ({
      catalogRefId: String(i.sku),
      productId: String(i.sku),
      quantity: i.quantity || 1,
      substitutionSelection: i.substitution || 'SHOPPER_CHOICE',
    }));
    const res = await this._wfs('POST', '/cart/OnDemand/itemV2', { body });
    return res.data;
  }

  /**
   * Set an item's quantity to an absolute value (gotcha #2 — PUT, not POST).
   * @param {string} commerceId - e.g. "ci2115702714"
   * @param {number} quantity
   */
  async setItemQuantity(commerceId, quantity) {
    const res = await this._wfs('PUT', `/cartV2/item/${encodeURIComponent(commerceId)}`, {
      body: { quantity },
    });
    return res.data;
  }

  /**
   * Remove a single item by commerceId (gotcha #3 — uses commerceItemInfo.id, not the SKU).
   * @param {string} commerceId
   */
  async removeItem(commerceId) {
    const res = await this._wfs('DELETE', '/cartV2/item', { body: { commerceId } });
    return res.data;
  }

  /** Clear the whole cart. Falls back to per-item removal if the bulk delete is rejected. */
  async clearCart() {
    const res = await this._wfs('DELETE', '/cart/OnDemand');
    if (res.status >= 200 && res.status < 300) return { success: true, raw: res.data };

    // Fallback: delete each item individually.
    const { items } = await this.getCart();
    for (const it of items) {
      if (it.commerceId) await this.removeItem(it.commerceId);
    }
    return { success: true, fallback: true };
  }

  // ── Addresses (WFS) ────────────────────────────────────────────────────────

  /** List saved addresses (normalized). Note placesId-vs-placeId (gotcha #4). */
  async getAddresses() {
    // Primary endpoint per the SKILL reference table; fall back to /addresses.
    let res = await this._wfs('GET', '/cart/checkout/savedAddresses');
    let list = this._extractAddresses(res.data);
    if (!list.length) {
      res = await this._wfs('GET', '/addresses');
      list = this._extractAddresses(res.data);
    }
    return list;
  }

  _extractAddresses(data) {
    if (!data) return [];
    const arr = Array.isArray(data) ? data
      : data.savedAddresses || data.addresses || data.items || data.data || [];
    if (!Array.isArray(arr)) return [];
    return arr.map(a => ({
      nickname: a.nickname || a.name || a.shipToAddressName || '',
      placesId: a.placesId || a.placeId || '',          // gotcha #4: response uses placesId
      placeId: a.placeId || a.placesId || '',           // normalized for other endpoints
      storeId: a.storeId || a.store_id || '',
      fullAddress: a.fullAddress || a.formattedAddress || a.address || a.addressLine1 || '',
      isDefault: !!(a.defaultAddress || a.isDefault || a.default),
      raw: a,
    }));
  }

  /** Resolve the delivery context (placeId/storeId/nickname) from config or saved addresses. */
  async _resolveDeliveryContext() {
    let placeId = CONFIG.PLACE_ID;
    let storeId = CONFIG.STORE_ID;
    let nickname = CONFIG.ADDRESS_NICKNAME;
    if (!placeId || !nickname || !storeId) {
      const addrs = await this.getAddresses();
      const def = addrs.find(a => a.placeId === placeId)
        || addrs.find(a => a.isDefault)
        || addrs[0];
      if (def) {
        placeId = placeId || def.placeId;
        storeId = storeId || def.storeId;
        nickname = nickname || def.nickname;
      }
    }
    return { placeId: placeId || '', storeId: storeId || '', nickname: nickname || '' };
  }

  // ── Timeslots / Checkout (WFS) ─────────────────────────────────────────────

  /**
   * Confirm delivery location and get available timeslots.
   * @returns {{ slots: Array, raw: object }}
   */
  async confirmLocation({ placeId, storeId, nickname } = {}) {
    const ctx = (placeId && nickname) ? { placeId, storeId, nickname } : await this._resolveDeliveryContext();
    if (!ctx.placeId) throw new Error('No delivery placeId — add one to creds (place_id) or save an address.');

    const res = await this._wfs('POST', '/cartV2/confirmLocation', {
      body: {
        address: { nickname: ctx.nickname, placeId: ctx.placeId },
        deliveryType: 'OnDemand',
        page: 'checkout',
        storeId: ctx.storeId,
      },
    });

    const slots = [];
    for (const day of (res.data && res.data.sortedJoinDeliverySlots) || []) {
      for (const w of day.week || []) {
        for (const ds of w.daySlots || []) slots.push(ds);
      }
    }
    return { slots, ctx, raw: res.data };
  }

  /** Parse a slot's "hourFrom" (e.g. "17pm", "9am") into a 24h start hour. */
  _slotStartHour(slot) {
    const hf = String(slot.hourFrom || '0am');
    let n = parseInt(hf.replace(/[^0-9]/g, ''), 10) || 0;
    if (/pm/i.test(hf) && n !== 12) n += 12;
    if (/am/i.test(hf) && n === 12) n = 0;
    return n;
  }

  /**
   * Set shipping details for a chosen slot. Returns web payment auth (jsessionId + auth).
   * @returns {{ jsessionId: string|null, auth: string|null, raw: object }}
   */
  async setShipping({ placeId, storeId, nickname, slot, driverTip = CONFIG.DRIVER_TIP } = {}) {
    const res = await this._wfs('POST', '/cart/checkout/shippingDetails', {
      body: {
        address: { placeId },
        appInstanceId: CONFIG.APP_INSTANCE_ID,
        deliverySpecialInstructions: '',
        deliveryType: 'OnDemand',
        driverTip,
        foodDeliverySlotId: slot.slotId,
        foodDeliveryStartHour: this._slotStartHour(slot),
        foodShipOnDate: slot.stringShipOnDate,
        giftMessage: '',
        giftNoteSelected: false,
        joinBasket: true,
        oddDeliverySlotId: '',
        otherDeliverySlotId: '',
        otherDeliveryStartHour: 0,
        otherShipOnDate: '',
        plasticBags: false,
        requestFrom: 'express',
        shipToAddressName: nickname,
        storeId,
        substituesAllowed: 'NO',
        suburbId: '',
        tokenProvider: 'firebase',
      },
    });
    return {
      jsessionId: (res.data && res.data.jsessionId) || null,
      auth: (res.data && res.data.auth) || null,
      raw: res.data,
    };
  }

  /** List saved payment cards via the web payment API (needs cookies from setShipping). */
  async getWebCards(jsessionId, auth) {
    const res = await request('GET', `${CONFIG.WEB_BASE}/server/getcreditcarddetails`, {
      headers: this.tokens.webHeaders(jsessionId, auth),
    });
    return (res.data && res.data.items) || [];
  }

  /**
   * Walk the checkout flow up to (but not through) 3DS payment.
   * Stops once we have a delivery slot, web auth, and the card list.
   * 3DS requires bank-app approval and is intentionally NOT automated.
   *
   * @param {object} opts - { slotIndex } which slot to use (default: last available)
   * @returns {{ cart, ctx, slot, jsessionId, auth, cards, ready, message }}
   */
  async walkCheckout({ slotIndex = null } = {}) {
    const cart = await this.getCart();
    if (!cart.count) {
      return { ready: false, cart, message: 'Cart is empty — add items first.' };
    }

    const { slots, ctx } = await this.confirmLocation();
    if (!slots.length) {
      return { ready: false, cart, ctx, message: 'No delivery timeslots available right now.' };
    }
    const slot = slotIndex != null ? slots[slotIndex] : slots[slots.length - 1];
    if (!slot) return { ready: false, cart, ctx, slots, message: `Slot index ${slotIndex} out of range.` };

    const { jsessionId, auth, raw: shipRaw } = await this.setShipping({
      placeId: ctx.placeId, storeId: ctx.storeId, nickname: ctx.nickname, slot,
    });
    if (!jsessionId || !auth) {
      return { ready: false, cart, ctx, slot, raw: shipRaw,
        message: 'Failed to obtain web payment auth from shippingDetails.' };
    }

    let cards = [];
    try { cards = await this.getWebCards(jsessionId, auth); } catch { /* best-effort */ }

    return {
      ready: true,
      cart, ctx, slot, jsessionId, auth, cards,
      message: '3DS payment requires bank-app approval — approve the push on your phone to complete.',
    };
  }

  // ── Orders (best-effort — not in the verified SKILL reference) ──────────────

  /** List past orders. The history endpoint is unverified, so this parses defensively. */
  async getOrders() {
    const res = await this._wfs('GET', '/orders');
    if (res.status >= 400) return { orders: [], status: res.status, raw: res.data };
    const data = res.data || {};
    const orders = Array.isArray(data) ? data
      : data.orders || data.data || (data.response && data.response.orders) || [];
    return { orders: Array.isArray(orders) ? orders : [], status: res.status, raw: data };
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

// Command name for usage/help. Resolves to "woolies" when run via the installed
// bin, and falls back to "woolies" when invoked directly as `node api-client.js`.
const PROG = (() => {
  const base = path.basename(process.argv[1] || '');
  return base && base !== 'api-client.js' ? base.replace(/\.js$/, '') : 'woolies';
})();

function isSku(s) { return /^\d{5,}$/.test(s); }
function isCommerceId(s) { return /^ci\d+$/i.test(s); }

async function main() {
  const client = new WoolworthsDash();
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case 'search': {
      const query = args.join(' ');
      if (!query) { console.log(`Usage: ${PROG} search <query>`); break; }
      console.log(`Searching: "${query}"`);
      const results = await client.searchProducts(query);
      if (!results.length) { console.log('No results found.'); break; }
      console.log(`\n  ${pad('#', 3)}${pad('Product', 42)}${pad('Price', 10)}SKU`);
      results.forEach((p, i) => {
        console.log(`  ${pad(i + 1, 3)}${pad(p.name, 42)}${pad(fmtR(p.price), 10)}${p.sku}`);
      });
      break;
    }

    case 'cart': {
      const { items, total, count } = await client.getCart();
      console.log(`Cart: ${count || 0} item(s)`);
      if (!items.length) { console.log('  (empty)'); break; }
      console.log(`\n  ${pad('Qty', 5)}${pad('Product', 42)}${pad('Line', 10)}commerceId`);
      for (const it of items) {
        const line = it.price != null ? fmtR(it.price * it.quantity) : '';
        console.log(`  ${pad('x' + it.quantity, 5)}${pad(it.name, 42)}${pad(line, 10)}${it.commerceId || ''}`);
      }
      if (total != null) console.log(`\n  Total: ${fmtR(total)}`);
      if (total != null && total < CONFIG.MIN_ORDER) {
        console.log(`  ⚠️  Below R${CONFIG.MIN_ORDER} minimum order value.`);
      }
      break;
    }

    case 'add': {
      // woolies add <query|sku> [qty]
      const target = args[0];
      const qty = parseInt(args[1], 10) || 1;
      if (!target) { console.log(`Usage: ${PROG} add <query|sku> [qty]`); break; }

      let sku, name;
      if (isSku(target)) {
        sku = target;
        try { name = (await client.productDetail(sku)).name; } catch { name = sku; }
      } else {
        const results = await client.searchProducts(target, { limit: 5 });
        if (!results.length) { console.log(`No results for "${target}"`); break; }
        sku = results[0].sku;
        name = results[0].name;
        console.log(`Found: ${name}${results[0].price != null ? ' — ' + fmtR(results[0].price) : ''}`);
      }

      await client.addItems([{ sku, quantity: qty }]);
      const cart = await client.getCart();
      console.log(`✅ Added x${qty} ${name} (additive). Cart now has ${cart.count} item(s)${cart.total != null ? ', ' + fmtR(cart.total) : ''}.`);
      break;
    }

    case 'remove': {
      // woolies remove <query|name|commerceId>
      const target = args.join(' ');
      if (!target) { console.log(`Usage: ${PROG} remove <query|name|commerceId>`); break; }

      // Direct commerceId removal — no need to fetch the cart.
      if (isCommerceId(target)) {
        await client.removeItem(target);
        console.log(`✅ Removed ${target}`);
        break;
      }

      const { items } = await client.getCart();
      if (!items.length) { console.log('Cart is empty'); break; }
      const lc = target.toLowerCase();
      const match = items.find(i => i.sku === target)
        || items.find(i => (i.name || '').toLowerCase().includes(lc));
      if (!match) { console.log(`"${target}" not found in cart`); break; }
      console.log(`Removing: ${match.name} (${match.commerceId})`);
      await client.removeItem(match.commerceId);
      const cart = await client.getCart();
      console.log(`✅ Cart now has ${cart.count} item(s)`);
      break;
    }

    case 'clear': {
      await client.clearCart();
      console.log('✅ Cart cleared');
      break;
    }

    case 'order': {
      // Quick order: search + add to cart. (Checkout/3DS is a separate, manual step.)
      const query = args.slice(0, -1).join(' ') || args[0];
      const qty = parseInt(args[args.length - 1], 10);
      const q = (args.length > 1 && !isNaN(qty)) ? query : args.join(' ');
      const quantity = (args.length > 1 && !isNaN(qty)) ? qty : 1;
      if (!q) { console.log(`Usage: ${PROG} order <query> [qty]`); break; }

      console.log(`Searching: "${q}"`);
      const results = await client.searchProducts(q, { limit: 5 });
      if (!results.length) { console.log(`No results for "${q}"`); break; }
      const pick = results[0];
      console.log(`Found: ${pick.name}${pick.price != null ? ' — ' + fmtR(pick.price) : ''}`);
      await client.addItems([{ sku: pick.sku, quantity }]);
      const cart = await client.getCart();
      console.log(`✅ Added x${quantity}. Cart: ${cart.count} item(s)${cart.total != null ? ', ' + fmtR(cart.total) : ''}.`);
      console.log(`   Run \`${PROG} checkout\` to pick a slot and start payment.`);
      break;
    }

    case 'addresses': {
      const addrs = await client.getAddresses();
      if (!addrs.length) { console.log('No saved addresses found.'); break; }
      for (const a of addrs) {
        const def = a.isDefault ? ' (default)' : '';
        console.log(`  ${a.nickname}${def}: ${a.fullAddress}`);
        console.log(`     placeId: ${a.placeId}  storeId: ${a.storeId || '?'}`);
      }
      break;
    }

    case 'timeslots': {
      const { slots, ctx } = await client.confirmLocation();
      console.log(`Delivery to: ${ctx.nickname || ctx.placeId} (store ${ctx.storeId || '?'})`);
      if (!slots.length) { console.log('No timeslots available.'); break; }
      slots.forEach((s, i) => {
        console.log(`  ${pad(i, 4)}${s.description || s.slotId} [${s.slotId}]`);
      });
      break;
    }

    case 'checkout': {
      const slotIndex = args[0] != null ? parseInt(args[0], 10) : null;
      const sep = '='.repeat(50);
      console.log(`${sep}\n  Woolworths Dash — Checkout\n${sep}`);

      const r = await client.walkCheckout({ slotIndex: isNaN(slotIndex) ? null : slotIndex });

      if (r.cart) {
        console.log(`  Cart: ${r.cart.count} item(s)${r.cart.total != null ? ', ' + fmtR(r.cart.total) : ''}`);
      }
      if (!r.ready) {
        console.log(`  ❌ ${r.message}`);
        if (r.slots) console.log(`     (${r.slots.length} slots available — pass a slot index)`);
        break;
      }

      console.log(`  ✅ Slot: ${r.slot.description || r.slot.slotId}`);
      console.log(`  ✅ Web payment auth obtained (jsessionId + auth)`);
      console.log(`  Cards on file: ${r.cards.length}`);
      for (const c of r.cards) {
        const last4 = c.creditCardNumber || c.maskedCardNumber || '????';
        const id = c.userCardId || c.id || '';
        console.log(`    - ${c.nickname || c.cardType || 'Card'} ****${last4} [${id}]`);
      }
      console.log(`\n  ⚠️  ${r.message}`);
      console.log('  Next (manual): select card → submit CVV → approve 3DS push on your bank app');
      console.log('       → POST /cart/checkoutComplete → GET /cart/checkout/submittedOrder');
      break;
    }

    case 'orders': {
      const { orders, status } = await client.getOrders();
      if (!orders.length) {
        console.log(`No orders found (history endpoint is best-effort; HTTP ${status}).`);
        break;
      }
      for (const o of orders) {
        const ref = o.orderId || o.reference || o.orderNumber || o.id || '?';
        const st = (o.status && (o.status.orderStatus || o.status)) || o.orderState || 'unknown';
        const tot = o.total != null ? fmtR(o.total)
          : (o.orderSummary && o.orderSummary.total != null ? fmtR(o.orderSummary.total) : '');
        console.log(`  #${ref} — ${st} ${tot}`);
      }
      break;
    }

    case 'token': {
      const t = client.tokens;
      const exp = t.sessionExpiry ? new Date(t.sessionExpiry).toISOString() : 'unknown';
      const valid = t.sessionExpiry && Date.now() < t.sessionExpiry;
      console.log('Session token:', t.sessionToken ? t.sessionToken.slice(0, 30) + '…' : 'none');
      console.log('Expires:', exp, valid ? '(valid)' : '(expired/unknown)');
      console.log('Refresh token:', t.refreshToken ? 'present' : 'none');
      console.log('Dyn_user_id:', t.dynUserId || 'not set');
      console.log('WFS base:', CONFIG.WFS_BASE);
      break;
    }

    case 'login': {
      console.log('Logging in via Cognito (USER_PASSWORD_AUTH)...');
      await client.tokens.login();
      console.log('✅ Login successful.');
      console.log('   Dyn_user_id:', client.tokens.dynUserId || '(not in token)');
      console.log('   Expires:', client.tokens.sessionExpiry ? new Date(client.tokens.sessionExpiry).toISOString() : 'unknown');
      break;
    }

    case 'help':
    case '--help':
    case '-h':
    case undefined:
    default:
      if (cmd && !['help', '--help', '-h'].includes(cmd)) console.log(`Unknown command: ${cmd}\n`);
      console.log(`
Woolworths Dash API Client

Usage: ${PROG} <command> [args]

Search & products:
  search <query>              Search products (Constructor.io, no auth)

Cart:
  cart                        Show cart contents
  add <query|sku> [qty]       Add to cart by search or SKU (quantity is ADDITIVE)
  remove <query|name|ciId>    Remove an item (by name match, SKU, or commerceId)
  clear                       Empty the cart
  order <query> [qty]         Quick order: search + add to cart

Account:
  addresses                   List saved delivery addresses
  timeslots                   Show available delivery timeslots
  token                       Show current token state
  login                       Force a fresh Cognito login

Checkout & orders:
  checkout [slotIndex]        Walk checkout up to 3DS (then approve on your bank app)
  orders                      List past orders (best-effort)

Credentials: ${CONFIG.CREDS_PATH}
`);
  }
}

module.exports = { WoolworthsDash, TokenManager, CONFIG, decodeJwt };

if (require.main === module) {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
