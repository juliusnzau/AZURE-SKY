/* Azure Sky — single-page storefront (vanilla JS, no build step). */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const S = { me: null, cats: [] };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KES = (c) => 'KES ' + (Number(c) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (d) => new Date(d).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
const PLACEHOLDER = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300'><rect width='400' height='300' fill='#e3f3ff'/><path d='M110 200a38 38 0 0 1 8-75 56 56 0 0 1 108-10 44 44 0 0 1 14 85z' fill='#fff'/></svg>");
const TAXL = { vat_16: 'incl. 16% VAT', zero_rated: 'VAT 0% (zero-rated)', exempt: 'VAT exempt', none: 'No VAT' };
const STATUS = { pending_payment: ['Awaiting payment', 'warn'], paid_held: ['Paid · held safely', 'ok'], shipped: ['Shipped', 'ok'], completed: ['Completed', 'ok'], cancelled: ['Cancelled', 'bad'], disputed: ['Disputed', 'bad'], refunded: ['Refunded', 'warn'] };
const tag = (s) => `<span class="tag ${STATUS[s]?.[1] || ''}">${STATUS[s]?.[0] || s}</span>`;
const taxLabel = (t, inc) => (t === 'vat_16' ? (inc ? 'incl. 16% VAT' : '+ 16% VAT added') : TAXL[t]);

function toast(msg, kind = '') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').append(t); setTimeout(() => t.remove(), 4500); }
const loading = () => { app.innerHTML = '<div class="spin" role="status" aria-label="Loading"></div>'; };

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {}; const tok = localStorage.getItem('az_token');
  if (tok) headers.Authorization = 'Bearer ' + tok;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch('/api' + path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401 && tok) { localStorage.removeItem('az_token'); S.me = null; drawNav(); } throw new Error(j.error || 'Something went wrong.'); }
  return j;
}
async function loadMe() {
  S.me = localStorage.getItem('az_token') ? await api('/me').catch(() => null) : null;
  drawNav();
}
function drawNav() {
  const m = S.me; const n = $('#nav');
  if (!m) { n.innerHTML = '<a href="#/login">Sign in</a><a href="#/register/buyer">Join</a><a href="#/register/seller">Sell</a>'; return; }
  const bell = `<a href="#/notifications" aria-label="Notifications">🔔${m.unread_notifications ? `<span class="badge">${m.unread_notifications}</span>` : ''}</a>`;
  const msg = `<a href="#/messages" aria-label="Messages">✉️${m.unread_messages ? `<span class="badge">${m.unread_messages}</span>` : ''}</a>`;
  const role = m.role === 'buyer'
    ? `<a href="#/cart">🛒${m.cart_count ? `<span class="badge">${m.cart_count}</span>` : ''}</a><a href="#/orders">Orders</a><a href="#/wallet">Wallet ${KES(m.wallet_cents).replace('KES ', '')}</a>`
    : m.role === 'seller' ? '<a href="#/seller">My shop</a><a href="#/orders">Orders</a>' : '<a href="#/admin">Admin</a>';
  n.innerHTML = `${role}${msg}${bell}<button data-act="logout">Sign out</button>`;
}

/* ---------- tiny router ---------- */
const routes = [];
const route = (re, fn) => routes.push([re, fn]);
async function router() {
  const raw = location.hash.slice(1) || '/'; const [path, qs] = raw.split('?'); const params = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const [re, fn] of routes) { const m = path.match(re); if (m) { try { loading(); await fn(m.slice(1), params); } catch (e) { app.innerHTML = `<div class="card banner bad">${esc(e.message)}</div>`; } window.scrollTo(0, 0); return; } }
  app.innerHTML = '<div class="card"><h2>Page not found</h2><a href="#/">Back to the marketplace</a></div>';
}
window.addEventListener('hashchange', router);
const need = (...roles) => { if (!S.me) { location.hash = '#/login'; throw new Error('Please sign in first.'); } if (roles.length && !roles.includes(S.me.role)) throw new Error('This page is for ' + roles.join('/') + ' accounts.'); };

/* ---------- event delegation ---------- */
const acts = {}; const forms = {};
document.addEventListener('click', (e) => { const t = e.target.closest('[data-act]'); if (t && acts[t.dataset.act]) { e.preventDefault(); acts[t.dataset.act](t, e); } });
document.addEventListener('submit', (e) => { const f = e.target.closest('[data-form]'); if (f && forms[f.dataset.form]) { e.preventDefault(); const b = f.querySelector('button:not([type=button])'); if (b) b.disabled = true; Promise.resolve(forms[f.dataset.form](f, e)).catch((er) => toast(er.message, 'err')).finally(() => { if (b) b.disabled = false; }); } });
acts.logout = () => { localStorage.removeItem('az_token'); S.me = null; drawNav(); location.hash = '#/'; };
forms.search = (f) => { location.hash = '#/?q=' + encodeURIComponent(new FormData(f).get('q') || ''); };

/* ---------- browse ---------- */
const card = (i) => `<article class="card product"><a href="#/item/${i.id}"><img class="ph" loading="lazy" src="${esc(i.photos[0] || PLACEHOLDER)}" alt="${esc(i.name)}"></a>
  <div class="body"><h3><a href="#/item/${i.id}">${esc(i.name)}</a></h3><div class="muted small">${esc(i.brand || '')}${i.brand ? ' · ' : ''}<a href="#/?shop=${esc(i.shop.slug)}">${esc(i.shop.name)}</a></div>
  <div class="price">${KES(i.price_cents)}</div><div class="small muted">${taxLabel(i.tax, i.tax_inclusive)}</div>
  <div class="row between" style="margin-top:auto">${i.in_stock ? `<span class="tag ok">${i.quantity} in stock</span>` : '<span class="tag bad">Sold out</span>'}
  <button class="btn sm" data-act="add" data-id="${i.id}" ${i.in_stock ? '' : 'disabled'}>Add</button></div></div></article>`;

route(/^\/$/, async (_, p) => {
  if (!S.cats.length) S.cats = await api('/categories');
  const qs = new URLSearchParams({ ...p, page: 1 }); const first = await api('/items?' + qs);
  app.innerHTML = `${p.q || p.category || p.shop ? '' : `<section class="hero"><h1>Everything you need,<br>delivered from across Kenya ☁</h1><p>Shop thousands of items from verified sellers. Pay with M-Pesa or Airtel Money — we hold your money until your order arrives.</p><a class="btn sun" href="#/register/seller">Open your shop</a></section>`}
  <div class="chips"><a class="chip ${!p.category ? 'on' : ''}" href="#/">All</a>${S.cats.map((c) => `<a class="chip ${String(p.category) === String(c.id) ? 'on' : ''}" href="#/?category=${c.id}">${esc(c.name)}</a>`).join('')}</div>
  <form class="toolbar" data-form="filter"><input type="hidden" name="category" value="${esc(p.category || '')}"><input type="hidden" name="shop" value="${esc(p.shop || '')}">
    <input name="q" placeholder="Search" value="${esc(p.q || '')}" style="max-width:220px"><input name="min" type="number" min="0" placeholder="Min KES" value="${esc(p.min || '')}" style="max-width:110px"><input name="max" type="number" min="0" placeholder="Max KES" value="${esc(p.max || '')}" style="max-width:110px">
    <select name="sort" style="max-width:190px"><option value="new">Newest</option><option value="price_asc">Price: low → high</option><option value="price_desc">Price: high → low</option><option value="relevance">Best match</option></select>
    <label class="row" style="margin:0"><input type="checkbox" name="in_stock" value="1" ${p.in_stock ? 'checked' : ''}> In stock</label><button class="btn sm">Filter</button></form>
  ${p.q ? `<h2>Results for “${esc(p.q)}”</h2>` : ''}
  <div class="grid" id="grid">${first.items.map(card).join('') || '<div class="card">Nothing found yet — try another search.</div>'}</div>
  ${first.items.length >= first.size ? '<p class="right"><button class="btn ghost" data-act="more" data-page="2">Show more</button></p>' : ''}`;
  $('select[name=sort]').value = p.sort || 'new'; app.dataset.qs = JSON.stringify(p);
});
forms.filter = (f) => { const d = new URLSearchParams(); for (const [k, v] of new FormData(f)) if (v) d.set(k, v); location.hash = '#/?' + d; };
acts.more = async (b) => { const p = JSON.parse(app.dataset.qs || '{}'); const page = Number(b.dataset.page); const r = await api('/items?' + new URLSearchParams({ ...p, page })); $('#grid').insertAdjacentHTML('beforeend', r.items.map(card).join('')); if (r.items.length < r.size) b.remove(); else b.dataset.page = page + 1; };
acts.add = async (b) => {
  if (!S.me) { location.hash = '#/login'; return toast('Sign in as a buyer to shop.'); }
  if (S.me.role !== 'buyer') return toast('Only buyer accounts can shop.', 'err');
  const qty = Number($('#qty')?.value || 1); b.disabled = true;
  try { const c = await api('/cart'); const ex = c.groups.flatMap((g) => g.lines).find((l) => l.item_id === b.dataset.id); await api('/cart/' + b.dataset.id, { method: 'PUT', body: { quantity: (ex ? ex.qty : 0) + qty } }); toast('Added to cart', 'ok'); await loadMe(); } catch (e) { toast(e.message, 'err'); } b.disabled = false;
};

route(/^\/item\/([\w-]+)$/, async ([id]) => {
  const i = await api('/items/' + id);
  app.innerHTML = `<div class="layout"><div class="card"><img class="bigimg" id="big" src="${esc(i.photos[0] || PLACEHOLDER)}" alt="${esc(i.name)}"><div class="thumbs">${i.photos.map((p) => `<img src="${esc(p)}" alt="" data-act="thumb">`).join('')}</div></div>
  <div class="card stack"><h1 style="margin:0">${esc(i.name)}</h1><div class="muted">${esc(i.category)}${i.brand ? ' · ' + esc(i.brand) : ''} · sold by <a href="#/?shop=${esc(i.shop.slug)}">${esc(i.shop.name)}</a></div>
  <div class="price" style="font-size:2rem">${KES(i.price_cents)}</div>
  <table><tr><td>Price before VAT</td><td class="right">${KES(i.net_cents)}</td></tr><tr><td>VAT (${TAXL[i.tax]})</td><td class="right">${KES(i.tax_cents)}</td></tr></table>
  <p>${esc(i.description) || '<span class="muted">No description.</span>'}</p>
  <div class="row">${i.in_stock ? `<span class="tag ok">${i.quantity} available</span><input id="qty" type="number" min="1" max="${i.quantity}" value="1" style="width:90px"><button class="btn sun" data-act="add" data-id="${i.id}">Add to cart</button>` : '<span class="tag bad">Sold out</span>'}</div>
  <p class="small muted">🔒 Pay with M-Pesa or Airtel Money. We hold your payment until you confirm delivery.</p></div></div>`;
});
acts.thumb = (t) => { $('#big').src = t.src; };

/* ---------- auth ---------- */
route(/^\/login$/, async () => {
  app.innerHTML = `<div class="card stack" style="max-width:440px;margin:30px auto"><h1 style="margin:0">Welcome back ☁</h1>
  <form class="stack" data-form="login"><div><label>Email</label><input name="email" type="email" required autocomplete="email"></div><div><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div><button class="btn">Sign in</button></form>
  <p class="muted">New here? <a href="#/register/buyer">Create a buyer account</a> or <a href="#/register/seller">open a shop</a>.</p></div>`;
});
forms.login = async (f) => { const r = await api('/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(f)) }); localStorage.setItem('az_token', r.token); await loadMe(); location.hash = S.me.role === 'seller' ? '#/seller' : S.me.role === 'admin' ? '#/admin' : '#/'; };

const idBlock = `<div class="two"><div><label>Full name</label><input name="full_name" required></div><div><label>Email</label><input name="email" type="email" required></div>
  <div><label>Phone (07… / 01…)</label><input name="phone" inputmode="tel" required placeholder="0712345678"></div><div><label>Password (8+ characters)</label><input name="password" type="password" minlength="8" required></div>
  <div><label>ID type</label><select name="id_type"><option value="national_id">National ID</option><option value="passport">Passport</option></select></div><div><label>ID / passport number</label><input name="id_number" required></div>
  <div><label>Passport photo</label><input name="passport_photo" type="file" accept="image/*" required></div></div>`;
const acctBlock = (title) => `<fieldset><legend>${title}</legend><div class="two"><div><label>Method</label><select name="account_kind" data-act-change="acct"><option value="mpesa">M-Pesa number</option><option value="airtel">Airtel Money number</option><option value="bank">Bank account</option></select></div>
  <div class="acct-mobile"><label>Mobile money phone</label><input name="account_phone" inputmode="tel" placeholder="0712345678"></div>
  <div class="acct-bank hide"><label>Bank name</label><input name="bank_name"></div><div class="acct-bank hide"><label>Account number</label><input name="account_number"></div><div class="acct-bank hide"><label>Account name</label><input name="account_name"></div></div></fieldset>`;
document.addEventListener('change', (e) => { if (e.target.dataset.actChange === 'acct') { const bank = e.target.value === 'bank'; document.querySelectorAll('.acct-bank').forEach((x) => x.classList.toggle('hide', !bank)); document.querySelectorAll('.acct-mobile').forEach((x) => x.classList.toggle('hide', bank)); } });
route(/^\/register\/(buyer|seller)$/, async ([role]) => {
  const seller = role === 'seller';
  app.innerHTML = `<div class="card stack" style="max-width:760px;margin:20px auto"><h1 style="margin:0">${seller ? 'Open your Azure Sky shop' : 'Create your buyer account'}</h1>
  <p class="muted">${seller ? 'We verify every seller with their business documents so buyers can shop with confidence.' : 'Your details keep deliveries and payments safe.'}</p>
  <form class="stack" data-form="register" data-role="${role}" enctype="multipart/form-data">${idBlock}
  ${seller ? `<fieldset><legend>Business details</legend><div class="two"><div><label>Business name</label><input name="business_name" required></div><div><label>Business registration number</label><input name="registration_no" required></div>
    <div><label>KRA PIN</label><input name="kra_pin" required placeholder="A123456789Z" pattern="[AaPp][0-9]{9}[A-Za-z]"></div><div><label>Business registration certificate (PDF/photo)</label><input name="registration_cert" type="file" accept="image/*,.pdf" required></div>
    <div><label>Business logo <span class="muted">(optional — your passport photo is used if empty)</span></label><input name="logo" type="file" accept="image/*"></div></div></fieldset>` : ''}
  ${acctBlock(seller ? 'Where should we pay you? (mobile money or bank)' : 'Your mobile money / bank account (for payments & refunds)')}
  <button class="btn">${seller ? 'Submit for verification' : 'Create account'}</button></form>
  <p class="muted small">Already registered? <a href="#/login">Sign in</a>. Documents are stored privately and only used for verification.</p></div>`;
});
forms.register = async (f) => { const fd = new FormData(f); const r = await api('/auth/register/' + f.dataset.role, { method: 'POST', form: fd }); localStorage.setItem('az_token', r.token); await loadMe(); toast('Welcome to Azure Sky! Check your email to verify your address.', 'ok'); location.hash = f.dataset.role === 'seller' ? '#/seller' : '#/'; };
route(/^\/verify\/(.+)$/, async ([t]) => { await api('/auth/verify/' + t); app.innerHTML = '<div class="card banner ok">Email verified — thank you! <a href="#/">Continue shopping</a></div>'; });

/* ---------- cart & checkout ---------- */
route(/^\/cart$/, async () => {
  need('buyer'); const [cart, addrs] = await Promise.all([api('/cart'), api('/addresses')]);
  if (!cart.groups.length) { app.innerHTML = '<div class="card"><h2>Your cart is empty</h2><a class="btn" href="#/">Start shopping</a></div>'; return; }
  app.innerHTML = `<div class="layout"><div class="stack">${cart.groups.map((g) => `<div class="card"><h3 style="margin-top:0">${esc(g.shop)}</h3><table>${g.lines.map((l) => `<tr><td><b>${esc(l.name)}</b><div class="small muted">${KES(l.unit_cents)} each</div></td>
    <td><span class="qty"><input type="number" min="0" max="${l.available}" value="${l.qty}" data-act-change="setqty" data-id="${l.item_id}"></span></td><td class="right">${KES(l.unit_cents * l.qty)}</td></tr>`).join('')}</table>
    <table class="small"><tr><td>Subtotal (excl. VAT)</td><td class="right">${KES(g.net)}</td></tr><tr><td>VAT</td><td class="right">${KES(g.tax)}</td></tr><tr><td>Delivery</td><td class="right">${KES(g.delivery)}</td></tr><tr><td><b>Order total</b></td><td class="right"><b>${KES(g.total)}</b></td></tr></table></div>`).join('')}</div>
  <div class="card stack"><h3 style="margin:0">Deliver to</h3>
  ${addrs.length ? `<select id="addr">${addrs.map((a) => `<option value="${a.id}" ${a.is_default ? 'selected' : ''}>${esc(a.recipient)} — ${esc(a.street)}, ${esc(a.town)} (${esc(a.phone)})</option>`).join('')}</select>` : '<div class="banner">Add a delivery address to continue.</div>'}
  <details ${addrs.length ? '' : 'open'}><summary><b>+ New delivery contact &amp; address</b></summary><form class="stack" data-form="addr" style="margin-top:10px"><div><label>Recipient name</label><input name="recipient" required value="${esc(S.me.full_name)}"></div><div><label>Phone</label><input name="phone" required value="${esc(S.me.phone)}"></div>
  <div class="two"><div><label>County</label><input name="county" required></div><div><label>Town / area</label><input name="town" required></div></div><div><label>Street, building or landmark</label><input name="street" required></div><div><label>Delivery notes</label><input name="notes"></div><button class="btn sm">Save address</button></form></details>
  <div class="row between"><b>Total</b><span class="price">${KES(cart.total_cents)}</span></div>
  <button class="btn sun" data-act="checkout" ${addrs.length ? '' : 'disabled'}>Place order &amp; get invoice</button><p class="small muted">You'll pay next with M-Pesa, Airtel Money or your wallet. Money is held until you confirm delivery.</p></div></div>`;
});
document.addEventListener('change', async (e) => { if (e.target.dataset.actChange === 'setqty') { try { await api('/cart/' + e.target.dataset.id, { method: 'PUT', body: { quantity: Number(e.target.value) } }); await loadMe(); router(); } catch (er) { toast(er.message, 'err'); router(); } } });
forms.addr = async (f) => { await api('/addresses', { method: 'POST', body: Object.fromEntries(new FormData(f)) }); toast('Address saved', 'ok'); router(); };
acts.checkout = async (b) => { b.disabled = true; try { const r = await api('/checkout', { method: 'POST', body: { address_id: $('#addr').value } }); await loadMe(); toast('Order placed! Check your email for the invoice.', 'ok'); location.hash = r.orders.length === 1 ? '#/orders/' + r.orders[0].id : '#/orders'; } catch (e) { toast(e.message, 'err'); b.disabled = false; } };

/* ---------- orders ---------- */
route(/^\/orders$/, async () => {
  need('buyer', 'seller', 'admin'); const o = await api('/orders');
  app.innerHTML = `<div class="card"><h2 style="margin-top:0">${S.me.role === 'admin' ? 'Disputed orders' : 'Your orders'}</h2>${o.length ? `<table><tr><th>#</th><th>Shop</th><th>Status</th><th>Total</th><th>Date</th><th></th></tr>${o.map((x) => `<tr><td>${x.number}</td><td>${esc(x.shop)}</td><td>${tag(x.status)}</td><td>${KES(x.total_cents)}</td><td>${when(x.created_at)}</td><td><a class="btn sm ghost" href="#/orders/${x.id}">Open</a></td></tr>`).join('')}</table>` : '<p class="muted">No orders yet.</p>'}</div>`;
});
let pollT;
route(/^\/orders\/([\w-]+)$/, async ([id]) => {
  need(); clearTimeout(pollT); const o = await api('/orders/' + id); const buyer = S.me.id === o.buyer_id; const sellerSide = S.me.id === o.seller_id;
  const flow = ['pending_payment', 'paid_held', 'shipped', 'completed']; const idx = flow.indexOf(o.status);
  const labels = ['1 · Pay', '2 · Seller delivers', '3 · You confirm', '4 · Seller paid'];
  const pending = o.payments.find((p) => p.status === 'initiated');
  app.innerHTML = `<div class="layout"><div class="stack"><div class="card stack"><div class="row between"><h2 style="margin:0">Order #${o.number}</h2>${tag(o.status)}</div>
  <div class="muted">${esc(o.shop)} · placed ${when(o.created_at)}</div>
  ${idx >= 0 ? `<div class="steps">${labels.map((l, i) => `<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${l}</span>`).join('')}</div>` : ''}
  <table><tr><th>Item</th><th>Qty</th><th class="right">Amount</th></tr>${o.items.map((i) => `<tr><td>${esc(i.name)}<div class="small muted">${TAXL[i.tax]}</div></td><td>${i.quantity}</td><td class="right">${KES((i.unit_net_cents + i.tax_cents) * i.quantity)}</td></tr>`).join('')}
  <tr><td colspan="2">Subtotal (excl. VAT)</td><td class="right">${KES(o.subtotal_cents)}</td></tr><tr><td colspan="2">VAT</td><td class="right">${KES(o.tax_cents)}</td></tr><tr><td colspan="2">Delivery</td><td class="right">${KES(o.delivery_fee_cents)}</td></tr><tr><td colspan="2"><b>Total</b></td><td class="right"><b>${KES(o.total_cents)}</b></td></tr>
  ${sellerSide && o.commission_cents ? `<tr><td colspan="2" class="muted">Azure Sky commission (3%)</td><td class="right muted">− ${KES(o.commission_cents)}</td></tr><tr><td colspan="2"><b>You receive</b></td><td class="right"><b>${KES(o.seller_net_cents)}</b></td></tr>` : ''}</table>
  ${o.address ? `<div class="banner ok"><b>Deliver to:</b> ${esc(o.address.recipient)} · ${esc(o.address.phone)}<br>${esc(o.address.street)}, ${esc(o.address.town)}, ${esc(o.address.county)}${o.address.notes ? '<br>' + esc(o.address.notes) : ''}</div>` : sellerSide ? '<div class="banner">Delivery details appear once the buyer has paid.</div>' : ''}
  ${o.tracking_note ? `<div class="banner">Shipping note: ${esc(o.tracking_note)}</div>` : ''}</div>
  ${buyer && o.status === 'pending_payment' ? `<div class="card stack"><h3 style="margin:0">Pay ${KES(o.total_cents)}</h3>${pending ? '<div class="banner">⏳ Waiting for your payment confirmation… approve the prompt on your phone.</div>' : ''}
   <form class="stack" data-form="pay" data-id="${o.id}"><div class="two"><div><label>Pay with</label><select name="method"><option value="mpesa">M-Pesa</option><option value="airtel">Airtel Money</option><option value="wallet">Azure Sky wallet (${KES(S.me.wallet_cents)})</option></select></div><div><label>Phone number</label><input name="phone" value="${esc(S.me.phone)}" inputmode="tel"></div></div>
   <div class="row"><button class="btn sun">Pay now</button><button type="button" class="btn ghost" data-act="cancel" data-id="${o.id}">Cancel order</button></div></form></div>` : ''}
  ${buyer && o.status === 'shipped' ? `<div class="card stack"><h3 style="margin:0">Received your order?</h3><p class="muted">Confirm delivery to release payment to the seller. Only confirm once you have the items.</p><div class="row"><button class="btn sun" data-act="confirm" data-id="${o.id}">✅ Confirm delivery</button><button class="btn ghost" data-act="dispute" data-id="${o.id}">Report a problem</button></div></div>` : ''}
  ${sellerSide && o.status === 'paid_held' ? `<div class="card stack"><h3 style="margin:0">Deliver this order</h3><form class="row" data-form="ship" data-id="${o.id}"><input name="tracking_note" placeholder="Courier / rider / tracking note (optional)" style="flex:1"><button class="btn sun">Mark as shipped</button></form></div>` : ''}
  ${S.me.role === 'admin' && o.status === 'disputed' ? `<div class="card row"><button class="btn" data-act="resolve" data-id="${o.id}" data-do="release">Release to seller</button><button class="btn danger" data-act="resolve" data-id="${o.id}" data-do="refund">Refund buyer</button></div>` : ''}</div>
  <div class="card stack"><h3 style="margin:0">Messages</h3><div class="chat" id="chat">${o.messages.map((m) => `<div class="msg ${m.sender_id === null ? 'sys' : m.sender_id === S.me.id ? 'me' : ''}">${esc(m.body)}<div class="small" style="opacity:.7">${when(m.created_at)}</div></div>`).join('') || '<span class="muted small">No messages yet.</span>'}</div>
  ${S.me.role !== 'admin' ? `<form class="row" data-form="chat" data-id="${o.id}"><input name="body" placeholder="Message the ${buyer ? 'seller' : 'buyer'}…" style="flex:1" required><button class="btn sm">Send</button></form>` : ''}</div></div>`;
  const c = $('#chat'); if (c) c.scrollTop = c.scrollHeight; loadMe();
  if (pending || o.status === 'pending_payment' && o.payments.length) pollT = setTimeout(() => { if (location.hash.includes(id)) router(); }, 4000);
});
forms.pay = async (f) => { const fd = Object.fromEntries(new FormData(f)); const r = await api(`/orders/${f.dataset.id}/pay`, { method: 'POST', body: fd }); toast(r.message, 'ok'); router(); };
forms.ship = async (f) => { await api(`/orders/${f.dataset.id}/ship`, { method: 'POST', body: Object.fromEntries(new FormData(f)) }); toast('Marked as shipped — the buyer was notified.', 'ok'); router(); };
forms.chat = async (f) => { await api(`/orders/${f.dataset.id}/messages`, { method: 'POST', body: Object.fromEntries(new FormData(f)) }); router(); };
acts.cancel = async (b) => { if (!confirm('Cancel this order?')) return; await api(`/orders/${b.dataset.id}/cancel`, { method: 'POST' }).catch((e) => toast(e.message, 'err')); router(); };
acts.confirm = async (b) => { if (!confirm('Confirm you received everything? Payment will be released to the seller.')) return; try { await api(`/orders/${b.dataset.id}/confirm`, { method: 'POST' }); toast('Thank you! The seller has been paid.', 'ok'); } catch (e) { toast(e.message, 'err'); } router(); };
acts.dispute = async (b) => { const reason = prompt('What went wrong with this order?'); if (!reason) return; try { await api(`/orders/${b.dataset.id}/dispute`, { method: 'POST', body: { reason } }); toast('Dispute opened. Funds stay safe while we review.', 'ok'); } catch (e) { toast(e.message, 'err'); } router(); };
acts.resolve = async (b) => { try { await api(`/admin/orders/${b.dataset.id}/resolve`, { method: 'POST', body: { action: b.dataset.do } }); toast('Resolved', 'ok'); } catch (e) { toast(e.message, 'err'); } router(); };

/* ---------- wallet, notifications, messages ---------- */
route(/^\/wallet$/, async () => {
  need('buyer'); const w = await api('/wallet'); await loadMe();
  app.innerHTML = `<div class="layout"><div class="card stack"><h2 style="margin:0">Wallet</h2><div class="tile"><span class="muted">Available balance</span><b>${KES(w.balance_cents)}</b></div>
  <form class="stack" data-form="topup"><div class="two"><div><label>Top up with</label><select name="provider"><option value="mpesa">M-Pesa</option><option value="airtel">Airtel Money</option></select></div><div><label>Phone</label><input name="phone" value="${esc(S.me.phone)}"></div></div><div><label>Amount (KES)</label><input name="amount" type="number" min="10" max="150000" required></div><button class="btn sun">Top up</button></form></div>
  <div class="card"><h3 style="margin-top:0">Recent activity</h3>${w.topups.length || w.movements.length ? `<table>${w.topups.map((t) => `<tr><td>Top-up via ${t.provider}</td><td>${t.status}</td><td class="right">${KES(t.amount_cents)}</td></tr>`).join('')}${w.movements.map((m) => `<tr><td class="small">${esc(m.memo)}</td><td class="small">${when(m.created_at)}</td><td class="right">${m.amount_cents > 0 ? '+' : '−'}${KES(Math.abs(m.amount_cents))}</td></tr>`).join('')}</table>` : '<p class="muted">Nothing yet.</p>'}</div></div>`;
});
forms.topup = async (f) => { const r = await api('/wallet/topup', { method: 'POST', body: Object.fromEntries(new FormData(f)) }); toast(r.message, 'ok'); setTimeout(router, 5000); };
route(/^\/notifications$/, async () => {
  need(); const n = await api('/notifications'); await api('/notifications/read', { method: 'POST' }); loadMe();
  app.innerHTML = `<div class="card"><h2 style="margin-top:0">Notifications</h2>${n.map((x) => `<div class="notif ${x.read_at ? '' : 'unread'}"><b>${esc(x.title)}</b><div>${esc(x.body)}</div><div class="small muted">${when(x.created_at)}${x.link ? ` · <a href="#${esc(x.link)}">Open</a>` : ''}</div></div>`).join('') || '<p class="muted">You\'re all caught up ☁</p>'}</div>`;
});
route(/^\/messages$/, async () => {
  need(); const m = await api('/messages');
  app.innerHTML = `<div class="card"><h2 style="margin-top:0">Messages</h2>${m.map((x) => `<div class="notif ${x.unread ? 'unread' : ''}"><a href="#/orders/${x.order_id}"><b>Order #${x.number}</b></a><div>${esc(x.body)}</div><div class="small muted">${when(x.created_at)}</div></div>`).join('') || '<p class="muted">No conversations yet. Messages about your orders appear here.</p>'}</div>`;
});

/* ---------- seller dashboard ---------- */
route(/^\/seller$/, async (_, p) => {
  need('seller'); const [sum, shops, cats, brands] = await Promise.all([api('/seller/summary'), api('/seller/shops'), api('/categories'), api('/brands')]);
  S.cats = cats; const shopId = p.shop || shops[0]?.id; const stock = shopId ? await api(`/seller/shops/${shopId}/stock`) : null; const kyc = S.me.kyc;
  const catOpts = cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join(''); const brandOpts = brands.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  app.innerHTML = `<div class="stack">${kyc === 'approved' ? '' : `<div class="banner ${kyc === 'rejected' ? 'bad' : ''}">${kyc === 'rejected' ? 'Your application was not approved: ' + esc(S.me.kyc_note || 'please contact support.') : '⏳ Your documents are under review. You can set up stock now — items go live once you are approved.'}</div>`}
  <div class="tiles"><div class="tile"><span class="muted">To ship</span><b>${sum.to_ship}</b></div><div class="tile"><span class="muted">In transit</span><b>${sum.in_transit}</b></div><div class="tile"><span class="muted">Held for you</span><b>${KES(sum.held_cents)}</b></div><div class="tile"><span class="muted">Earned (after 3%)</span><b>${KES(sum.earned_cents)}</b></div></div>
  <div class="card stack"><div class="row between"><h2 style="margin:0">Stock</h2><div class="row"><select id="shopSel">${shops.map((s) => `<option value="${s.id}" ${s.id === shopId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select><button class="btn sm ghost" data-act="newshop">+ New shop</button></div></div>
  ${stock ? `<div class="muted">${stock.total_units} units in <b>${esc(stock.shop.name)}</b>. Shop › Category › Brand › Item › Quantity.</div><div class="tree">${stock.categories.map((c) => `<details open><summary>${esc(c.category)} <span class="tag">${c.total_units} units</span></summary>${c.brands.map((b) => `<div class="brand-g"><details open><summary>${esc(b.brand)} <span class="tag">${b.total_units}</span></summary>
  <table>${b.items.map((i) => `<tr><td style="width:56px"><img src="${esc(i.photo || PLACEHOLDER)}" width="48" height="48" style="border-radius:10px;object-fit:cover" alt=""></td><td><b>${esc(i.name)}</b><div class="small muted">${KES(i.price_cents)} · ${taxLabel(i.tax, i.tax_inclusive)}${i.sku ? ' · ' + esc(i.sku) : ''}</div></td>
  <td class="right"><span class="qty"><button class="btn sm ghost" data-act="stock" data-id="${i.id}" data-d="-1">−</button><input type="number" min="0" value="${i.quantity}" data-act-change="setstock" data-id="${i.id}"><button class="btn sm ghost" data-act="stock" data-id="${i.id}" data-d="1">+</button></span></td>
  <td><button class="btn sm ghost" data-act="delitem" data-id="${i.id}">Remove</button></td></tr>`).join('')}</table></details></div>`).join('')}</details>`).join('') || '<p class="muted">No items yet — add your first one below.</p>'}</div>` : '<p class="muted">Create a shop to begin.</p>'}</div>
  ${shopId ? `<div class="card stack"><h2 style="margin:0">Add an item</h2><form class="stack" data-form="item" data-shop="${shopId}" enctype="multipart/form-data"><div class="two">
  <div><label>Item name</label><input name="name" required></div><div><label>SKU (optional)</label><input name="sku"></div>
  <div><label>Category</label><select name="category_id" id="catSel">${catOpts}<option value="__new">+ New category…</option></select><input name="new_category" class="hide" placeholder="New category name" style="margin-top:6px"></div>
  <div><label>Brand</label><select name="brand_id" id="brandSel"><option value="">No brand</option>${brandOpts}<option value="__new">+ New brand…</option></select><input name="new_brand" class="hide" placeholder="New brand name" style="margin-top:6px"></div>
  <div><label>Price (KES)</label><input name="price" type="number" min="0" step="0.01" required></div><div><label>Quantity available</label><input name="quantity" type="number" min="0" value="1" required></div>
  <div><label>Tax</label><select name="tax"><option value="vat_16">VAT 16%</option><option value="zero_rated">Zero-rated (0%)</option><option value="exempt">VAT exempt</option><option value="none">No VAT</option></select></div>
  <div><label>Price already includes VAT?</label><select name="tax_inclusive"><option value="true">Yes — VAT included</option><option value="false">No — add VAT on top</option></select></div></div>
  <div><label>Description</label><textarea name="description" rows="3"></textarea></div><div><label>Photos (up to 6)</label><input name="photos" type="file" accept="image/*" multiple></div><button class="btn">Publish item</button></form></div>` : ''}
  <div class="card"><div class="row between"><h2 style="margin:0">Recent orders</h2><a href="#/orders">All orders</a></div><div id="sellerOrders" class="muted">Loading…</div></div></div>`;
  api('/orders').then((o) => { $('#sellerOrders').innerHTML = o.length ? `<table>${o.slice(0, 8).map((x) => `<tr><td>#${x.number}</td><td>${tag(x.status)}</td><td>${KES(x.total_cents)}</td><td><a href="#/orders/${x.id}">Open</a></td></tr>`).join('')}</table>` : 'No orders yet.'; });
  $('#shopSel')?.addEventListener('change', (e) => { location.hash = '#/seller?shop=' + e.target.value; });
  for (const [sel, name] of [['#catSel', 'new_category'], ['#brandSel', 'new_brand']]) $(sel)?.addEventListener('change', (e) => $(`input[name=${name}]`).classList.toggle('hide', e.target.value !== '__new'));
});
forms.item = async (f) => {
  const fd = new FormData(f);
  if (fd.get('category_id') === '__new') { const n = String(fd.get('new_category') || '').trim(); if (!n) throw new Error('Enter the new category name.'); fd.set('category_id', (await api('/seller/categories', { method: 'POST', body: { name: n } })).id); }
  if (fd.get('brand_id') === '__new') { const n = String(fd.get('new_brand') || '').trim(); if (!n) throw new Error('Enter the new brand name.'); fd.set('brand_id', (await api('/seller/brands', { method: 'POST', body: { name: n } })).id); }
  fd.delete('new_category'); fd.delete('new_brand');
  await api(`/seller/shops/${f.dataset.shop}/items`, { method: 'POST', form: fd }); toast('Item published', 'ok'); router();
};
document.addEventListener('change', async (e) => { if (e.target.dataset.actChange === 'setstock') { try { await api(`/seller/items/${e.target.dataset.id}/stock`, { method: 'POST', body: { set: Number(e.target.value) } }); toast('Quantity updated', 'ok'); router(); } catch (er) { toast(er.message, 'err'); } } });
acts.stock = async (b) => { try { await api(`/seller/items/${b.dataset.id}/stock`, { method: 'POST', body: { delta: Number(b.dataset.d) } }); router(); } catch (e) { toast(e.message, 'err'); } };
acts.delitem = async (b) => { if (confirm('Remove this item from sale?')) { await api('/seller/items/' + b.dataset.id, { method: 'DELETE' }); router(); } };
acts.newshop = async () => { const name = prompt('New shop name'); if (!name) return; await api('/seller/shops', { method: 'POST', body: { name } }); router(); };

/* ---------- admin ---------- */
const openDoc = async (path) => { const r = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + localStorage.getItem('az_token') } }); if (!r.ok) return toast('Document not available', 'err'); window.open(URL.createObjectURL(await r.blob()), '_blank'); };
route(/^\/admin$/, async () => {
  need('admin'); const [st, sellers, payouts, disputes] = await Promise.all([api('/admin/stats'), api('/admin/sellers?status=pending'), api('/admin/payouts'), api('/orders')]);
  app.innerHTML = `<div class="stack"><div class="tiles"><div class="tile"><span class="muted">Held in escrow</span><b>${KES(st.escrow_cents)}</b></div><div class="tile"><span class="muted">Commission earned</span><b>${KES(st.commission_cents)}</b></div><div class="tile"><span class="muted">Buyers / Sellers</span><b>${st.buyers} / ${st.sellers}</b></div><div class="tile"><span class="muted">Orders</span><b>${st.orders}</b></div></div>
  <div class="card"><h2 style="margin-top:0">Sellers awaiting verification (${sellers.length})</h2>${sellers.map((s) => `<div class="notif"><b>${esc(s.business_name)}</b> — ${esc(s.full_name)} · ${esc(s.email)} · ${esc(s.phone)}<div class="small muted">Reg: ${esc(s.registration_no)} · KRA: ${esc(s.kra_pin)} · ${esc(s.id_type)} ${esc(s.id_number)} · Payout: ${s.payout_account ? esc(s.payout_account.kind + ' ' + (s.payout_account.phone || s.payout_account.account_number)) : '—'}</div>
  <div class="row" style="margin-top:6px"><button class="btn sm ghost" data-act="doc" data-p="/admin/docs/${s.id}/cert">Certificate</button><button class="btn sm ghost" data-act="doc" data-p="/admin/docs/${s.id}/passport">Passport photo</button><button class="btn sm" data-act="kyc" data-id="${s.id}" data-do="approve">Approve</button><button class="btn sm danger" data-act="kyc" data-id="${s.id}" data-do="reject">Reject</button></div></div>`).join('') || '<p class="muted">None pending.</p>'}</div>
  <div class="card"><h2 style="margin-top:0">Seller payouts</h2><table><tr><th>Order</th><th>Seller</th><th>To</th><th>Amount</th><th>Status</th><th></th></tr>${payouts.map((p) => `<tr><td>#${p.number}</td><td>${esc(p.business_name)}</td><td>${esc(p.method)} ${esc(p.destination)}</td><td>${KES(p.amount_cents)}</td><td>${esc(p.status)}${p.error ? `<div class="small muted">${esc(p.error)}</div>` : ''}</td>
  <td>${p.status === 'paid' ? '' : `<button class="btn sm" data-act="paid" data-id="${p.id}">Mark paid</button> ${p.status === 'failed' ? `<button class="btn sm ghost" data-act="retry" data-id="${p.id}">Retry</button>` : ''}`}</td></tr>`).join('')}</table></div>
  <div class="card"><h2 style="margin-top:0">Open disputes (${disputes.length})</h2>${disputes.map((d) => `<div class="notif"><a href="#/orders/${d.id}">Order #${d.number}</a> · ${esc(d.shop)} · ${KES(d.total_cents)}</div>`).join('') || '<p class="muted">No disputes.</p>'}</div></div>`;
});
acts.doc = (b) => openDoc(b.dataset.p);
acts.kyc = async (b) => { const note = b.dataset.do === 'reject' ? prompt('Reason for rejection (shown to the seller)') : null; if (b.dataset.do === 'reject' && !note) return; await api(`/admin/sellers/${b.dataset.id}/${b.dataset.do}`, { method: 'POST', body: { note } }); router(); };
acts.paid = async (b) => { const reference = prompt('Payment reference (M-Pesa/bank ref)') || 'manual'; await api(`/admin/payouts/${b.dataset.id}/mark-paid`, { method: 'POST', body: { reference } }); router(); };
acts.retry = async (b) => { await api(`/admin/payouts/${b.dataset.id}/retry`, { method: 'POST' }); toast('Retry queued', 'ok'); router(); };

/* ---------- boot ---------- */
(async () => { await loadMe(); await router(); setInterval(() => { if (S.me && !document.hidden) loadMe(); }, 30000); })();
