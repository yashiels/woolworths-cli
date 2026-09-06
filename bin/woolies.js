#!/usr/bin/env node
const path = require('path');
const { WoolworthsDash, CONFIG } = require('../lib/api-client.js');

// ─── CLI Helpers ─────────────────────────────────────────────────────────────

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

// ─── CLI ─────────────────────────────────────────────────────────────────────

// Command name for usage/help. Resolves to "woolies" when run via the installed
// bin, and falls back to "woolies" when invoked directly as `node bin/woolies.js`.
const PROG = (() => {
  const base = path.basename(process.argv[1] || '');
  return base && base !== 'api-client.js' ? base.replace(/\.js$/, '') : 'woolies';
})();

// Baked in at compile time for the standalone binaries (`bun build --define`),
// which can't read package.json at runtime. The require() below is authoritative
// for the npm/node install, where package.json ships alongside bin/.
let VERSION =
  typeof __WOOLIES_VERSION__ === 'string' && __WOOLIES_VERSION__ ? __WOOLIES_VERSION__ : '0.1.0';
try { VERSION = require('../package.json').version || VERSION; } catch {}

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
      console.log(`\n  ${pad('#', 3)}${pad('Product', 42)}${pad('Price', 10)}${pad('SKU', 12)}Link`);
      results.forEach((p, i) => {
        console.log(`  ${pad(i + 1, 3)}${pad(p.name, 42)}${pad(fmtR(p.price), 10)}${pad(p.sku, 12)}${p.url || ''}`);
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
        console.log(`Found: ${name}${results[0].price != null ? ' — ' + fmtR(results[0].price) : ''}${results[0].url ? '  ' + results[0].url : ''}`);
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
      console.log(`Found: ${pick.name}${pick.price != null ? ' — ' + fmtR(pick.price) : ''}${pick.url ? '  ' + pick.url : ''}`);
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

    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      break;

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

Other:
  version                     Print the CLI version

Credentials: ${CONFIG.CREDS_PATH}
`);
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
