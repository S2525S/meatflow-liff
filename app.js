'use strict';

const CONFIG = window.MEATFLOW_CONFIG || {};
const state = { profile:null, idToken:'', customer:null, products:[], pendingOrder:null };
let jsonpCounter = 0;
let submitTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('retryButton').addEventListener('click', initializeApp);
  document.getElementById('addItemButton').addEventListener('click', addItem);
  document.getElementById('orderForm').addEventListener('submit', showConfirmation);
  document.getElementById('editButton').addEventListener('click', () => showView('appView'));
  document.getElementById('submitButton').addEventListener('click', submitOrder);
  document.getElementById('closeButton').addEventListener('click', closeWindow);
  window.addEventListener('message', receiveSubmitResult);
  initializeApp();
});

async function initializeApp() {
  showView('loadingView');
  setLoading('LIFFを初期化しています。');
  try {
    validateConfig();
    await withTimeout(liff.init({ liffId: CONFIG.LIFF_ID }), 15000, 'LIFFの初期化がタイムアウトしました。');

    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href.split('#')[0] });
      return;
    }

    setLoading('LINEプロフィールを確認しています。');
    state.profile = await liff.getProfile();
    state.idToken = liff.getIDToken();

    if (!state.idToken) {
      throw new Error('LINEのIDトークンを取得できません。LINE DevelopersのScopeで openid を有効にしてください。');
    }

    setLoading('取引先と商品を読み込んでいます。');
    const data = await jsonp('bootstrap', { idToken: state.idToken });

    if (!data.ok) throw new Error(data.error || '初期データを取得できませんでした。');
    state.customer = data.customer;
    state.products = data.products || [];

    if (!state.customer?.registered) throw new Error('このLINEアカウントは取引先登録されていません。');
    if (!state.products.length) throw new Error('注文できる商品が登録されていません。');

    document.getElementById('customerName').textContent = state.customer.customerName || '取引先';
    document.getElementById('deliveryOption').classList.toggle('hidden', !state.customer.deliveryAllowed);
    document.getElementById('pickupOption').classList.toggle('hidden', !state.customer.pickupAllowed);
    setMinimumDate();
    document.getElementById('itemsContainer').innerHTML = '';
    addItem();
    showView('appView');
  } catch (e) {
    showError(e);
  }
}

function validateConfig() {
  if (!CONFIG.LIFF_ID || CONFIG.LIFF_ID.includes('ここに')) throw new Error('config.jsのLIFF_IDを設定してください。');
  if (!CONFIG.GAS_WEB_APP_URL || CONFIG.GAS_WEB_APP_URL.includes('ここに') || !CONFIG.GAS_WEB_APP_URL.endsWith('/exec')) {
    throw new Error('config.jsのGAS_WEB_APP_URLへ、Apps Scriptの /exec URLを設定してください。');
  }
}

function jsonp(action, params={}) {
  return new Promise((resolve, reject) => {
    const callback = '__meatflowJsonp' + (++jsonpCounter);
    const script = document.createElement('script');
    const timeout = setTimeout(() => cleanup(new Error('Apps Scriptとの通信がタイムアウトしました。')), 20000);

    function cleanup(error, value) {
      clearTimeout(timeout);
      delete window[callback];
      script.remove();
      error ? reject(error) : resolve(value);
    }

    window[callback] = value => cleanup(null, value);
    script.onerror = () => cleanup(new Error('Apps Script APIを読み込めませんでした。'));

    const url = new URL(CONFIG.GAS_WEB_APP_URL);
    url.searchParams.set('action', action);
    url.searchParams.set('callback', callback);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
    script.src = url.toString();
    document.head.appendChild(script);
  });
}

function addItem() {
  const fragment = document.getElementById('itemTemplate').content.cloneNode(true);
  const card = fragment.querySelector('.item-card');
  const select = fragment.querySelector('.product-select');
  const unit = fragment.querySelector('.unit-input');

  state.products.forEach(p => {
    const o = document.createElement('option');
    o.value = p.productCode;
    o.textContent = p.productName;
    o.dataset.productName = p.productName;
    o.dataset.defaultUnit = p.defaultUnit || 'kg';
    select.appendChild(o);
  });

  select.addEventListener('change', () => {
    unit.value = select.options[select.selectedIndex]?.dataset.defaultUnit || '';
  });

  fragment.querySelector('.remove-item-button').addEventListener('click', () => {
    if (document.querySelectorAll('.item-card').length <= 1) return alert('商品は1件以上必要です。');
    card.remove(); renumber();
  });

  document.getElementById('itemsContainer').appendChild(fragment);
  renumber();
}

function renumber() {
  document.querySelectorAll('.item-card').forEach((card,i) => {
    card.querySelector('.item-number').textContent = `商品 ${i+1}`;
  });
}

function collectOrder() {
  const deliveryDate = document.getElementById('deliveryDate').value;
  const receiveMethod = document.querySelector('input[name="receiveMethod"]:checked')?.value || '';
  if (!deliveryDate) throw new Error('希望日を入力してください。');
  if (!receiveMethod) throw new Error('受取方法を選択してください。');

  const items = [...document.querySelectorAll('.item-card')].map((card,i) => {
    const select = card.querySelector('.product-select');
    const quantity = Number(card.querySelector('.quantity-input').value);
    const unit = card.querySelector('.unit-input').value.trim();
    if (!select.value) throw new Error(`${i+1}件目の商品を選択してください。`);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`${i+1}件目の数量を正しく入力してください。`);
    if (!unit) throw new Error(`${i+1}件目の単位を入力してください。`);
    return {
      productCode: select.value,
      productName: select.options[select.selectedIndex].dataset.productName || select.options[select.selectedIndex].textContent,
      quantity, unit,
      note: card.querySelector('.item-note-input').value.trim()
    };
  });

  return {
    deliveryDate, receiveMethod,
    preferredTime: document.getElementById('preferredTime').value,
    orderNote: document.getElementById('orderNote').value.trim(),
    items
  };
}

function showConfirmation(event) {
  event.preventDefault();
  try {
    state.pendingOrder = collectOrder();
    const o = state.pendingOrder;
    const items = o.items.map((x,i) => `<div class="summary-card"><h2>商品 ${i+1}</h2><dl>
      ${row('商品',x.productName)}${row('数量',`${x.quantity} ${x.unit}`)}${row('備考',x.note||'なし')}</dl></div>`).join('');
    document.getElementById('confirmationContent').innerHTML = `<div class="summary-card"><dl>
      ${row('取引先',state.customer.customerName)}${row('希望日',o.deliveryDate)}
      ${row('受取方法',o.receiveMethod)}${row('希望時間帯',o.preferredTime||'指定なし')}
      ${row('全体備考',o.orderNote||'なし')}</dl></div>${items}`;
    showView('confirmView'); scrollTo(0,0);
  } catch(e) { alert(e.message); }
}

function submitOrder() {
  if (!state.pendingOrder) return;
  const button = document.getElementById('submitButton');
  button.disabled = true; button.textContent = '送信しています…';

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = CONFIG.GAS_WEB_APP_URL;
  form.target = 'submitFrame';
  form.className = 'hidden';

  const fields = {
    action: 'submitOrder',
    idToken: state.idToken,
    payload: JSON.stringify(state.pendingOrder),
    origin: location.origin
  };
  Object.entries(fields).forEach(([name,value]) => {
    const input = document.createElement('input');
    input.name = name; input.value = value; form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
  form.remove();

  clearTimeout(submitTimer);
  submitTimer = setTimeout(() => {
    button.disabled = false; button.textContent = 'この内容で発注する';
    alert('注文送信がタイムアウトしました。通信状態を確認してください。');
  }, 30000);
}

function receiveSubmitResult(event) {
  if (!event.data || event.data.source !== 'MeatFlowAppsScript') return;
  clearTimeout(submitTimer);
  const button = document.getElementById('submitButton');
  button.disabled = false; button.textContent = 'この内容で発注する';

  if (!event.data.ok) return alert('注文を保存できませんでした。\n' + (event.data.error || '不明なエラー'));
  document.getElementById('completedOrderId').textContent = event.data.orderId;
  showView('completeView'); scrollTo(0,0);
}

function row(label,value) {
  return `<div class="summary-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}
function setMinimumDate() {
  const d = new Date(), local = new Date(d.getTime()-d.getTimezoneOffset()*60000);
  document.getElementById('deliveryDate').min = local.toISOString().slice(0,10);
}
function showView(id) {
  ['loadingView','errorView','appView','confirmView','completeView'].forEach(x =>
    document.getElementById(x).classList.toggle('hidden', x !== id));
}
function setLoading(s) { document.getElementById('loadingMessage').textContent = s; }
function showError(e) { document.getElementById('errorMessage').textContent = e?.message || String(e); showView('errorView'); }
function closeWindow() { if (liff.isInClient()) liff.closeWindow(); }
function withTimeout(p,ms,msg) { return Promise.race([p,new Promise((_,r)=>setTimeout(()=>r(new Error(msg)),ms))]); }
function escapeHtml(v) { return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
