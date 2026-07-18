'use strict';

const CONFIG = window.MEATFLOW_CONFIG || {};
const state = {
  profile: null,
  idToken: '',
  customer: null,
  member: null,
  products: [],
  favorites: [],
  pendingOrder: null,
  historyPage: 0,
  historyHasMore: false,
  historyLoading: false,
  historyRequestId: 0,
  renderedOrderIds: new Set()
};
let jsonpCounter = 0;
let submitTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  byId('retryButton').onclick = initializeApp;
  byId('pendingRetryButton').onclick = initializeApp;
  byId('registrationForm').onsubmit = registerMember;
  byId('addItemButton').onclick = () => addItem();
  byId('orderForm').onsubmit = showConfirmation;
  byId('editButton').onclick = () => showOnly('mainView');
  byId('submitButton').onclick = submitOrder;
  byId('closeButton').onclick = () => liff.isInClient() ? liff.closeWindow() : location.reload();
  byId('newOrderTab').onclick = () => switchTab('new');
  byId('favoriteTab').onclick = () => switchTab('favorite');
  byId('historyTab').onclick = () => switchTab('history');
  byId('historySearchButton').onclick = () => loadHistory(true);
  byId('historyKeyword').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); loadHistory(true); } };
  byId('loadMoreHistoryButton').onclick = () => loadHistory(false);
  byId('saveDraftButton').onclick = saveDraft;
  byId('deleteDraftButton').onclick = deleteDraft;
  byId('saveAsFavoriteButton').onclick = saveCurrentItemsAsFavorite;
  document.querySelectorAll('input[name="dateMode"]').forEach(x => x.onchange = updateDateMode);
  window.addEventListener('message', receiveSubmitResult);
  initializeApp();
});

async function initializeApp() {
  showOnly('loadingView');
  byId('loadingMessage').textContent = 'LINEの情報を確認しています。';
  try {
    validateConfig();
    await timeout(liff.init({ liffId: CONFIG.LIFF_ID }), 15000, 'LIFF初期化がタイムアウトしました。');
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href.split('#')[0] });
      return;
    }
    state.profile = await liff.getProfile();
    state.idToken = liff.getIDToken();
    if (!state.idToken) throw new Error('LINE IDトークンを取得できません。');

    const data = await jsonp('bootstrap', { idToken: state.idToken });
    if (!data.ok) throw new Error(data.error || '初期データを取得できません。');

    if (data.registrationRequired) {
      showOnly('registrationView');
      return;
    }
    if (data.memberStatus && data.memberStatus !== '有効') {
      showOnly('pendingView');
      return;
    }

    state.customer = data.customer;
    state.member = data.member || null;
    state.products = data.products || [];
    state.favorites = data.favorites || [];
    if (!state.customer?.registered) throw new Error('このLINEアカウントは取引先登録されていません。');

    byId('customerName').textContent = state.customer.customerName || '取引先';
    byId('memberName').textContent = state.member?.memberName || state.profile?.displayName || '';
    if (state.profile?.pictureUrl) {
      byId('profileImage').src = state.profile.pictureUrl;
      byId('profileImage').classList.remove('hidden');
    }
    renderReceiveMethods();
    renderFavorites();
    setMinimumDate();
    resetOrderForm();
    if (data.draft?.payload) {
      applyOrderToForm(data.draft.payload);
      byId('draftNoticeText').textContent = `${data.draft.savedAt} に保存した下書きを復元しました。`;
      byId('draftNotice').classList.remove('hidden');
    }
    showOnly('mainView');
    switchTab('new');
  } catch (e) {
    byId('errorMessage').textContent = e.message || String(e);
    showOnly('errorView');
  }
}

async function registerMember(e) {
  e.preventDefault();
  const button = byId('registrationSubmitButton');
  button.disabled = true;
  button.textContent = '登録しています…';
  try {
    const result = await postAction('registerMember', {
      customerCode: byId('registrationCustomerCode').value.trim(),
      registrationCode: byId('registrationCode').value.trim(),
      memberName: byId('registrationMemberName').value.trim()
    });
    if (!result.ok) throw new Error(result.error || '登録できませんでした。');
    byId('registrationMessage').textContent = result.memberStatus === '有効'
      ? '登録が完了しました。画面を再読み込みします。'
      : '登録を受け付けました。管理者の承認をお待ちください。';
    setTimeout(initializeApp, 700);
  } catch (err) {
    alert(err.message || String(err));
  } finally {
    button.disabled = false;
    button.textContent = '登録する';
  }
}

function switchTab(tab) {
  const isNew = tab === 'new';
  const isFavorite = tab === 'favorite';
  const isHistory = tab === 'history';
  byId('newOrderPanel').classList.toggle('hidden', !isNew);
  byId('favoritePanel').classList.toggle('hidden', !isFavorite);
  byId('historyPanel').classList.toggle('hidden', !isHistory);
  byId('newOrderTab').classList.toggle('active', isNew);
  byId('favoriteTab').classList.toggle('active', isFavorite);
  byId('historyTab').classList.toggle('active', isHistory);
  byId('screenTitle').innerHTML = isNew
    ? '<span class="company-title">株式会社髙那（担たん亭）</span><span class="system-title">発注システム</span>'
    : isFavorite ? '<span class="single-title">お気に入りセット</span>'
      : '<span class="single-title">注文履歴から発注</span>';
  if (isHistory && state.historyPage === 0 && !state.historyLoading) loadHistory(true);
}

function renderReceiveMethods() {
  const c = state.customer;
  const area = byId('receiveMethodArea');
  area.innerHTML = '';
  const options = [];
  if (c.deliveryAllowed) options.push(['配送希望', '配送希望', '※ 配送日時は、ご希望に添えない場合があります。']);
  if (c.pickupAllowed) options.push(['店舗受取（担たん亭でのお受け取り）', '店舗受取', '担たん亭でのお受け取り']);
  options.forEach(([value, title, small]) => {
    const label = document.createElement('label');
    label.className = 'radio-card';
    label.innerHTML = `<input type="radio" name="receiveMethod" value="${escapeHtml(value)}"><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(small)}</small></span>`;
    area.appendChild(label);
  });
  if (c.defaultReceiveMethod) {
    const target = [...area.querySelectorAll('input')].find(x => x.value === c.defaultReceiveMethod);
    if (target) target.checked = true;
  }
  if (c.receiveMode === '固定') area.querySelectorAll('input').forEach(x => x.disabled = true);
}

function resetOrderForm() {
  byId('itemsContainer').innerHTML = '';
  addItem();
  byId('deliveryDate').value = '';
  byId('deliveryCondition').value = '';
  byId('preferredTime').value = '';
  byId('orderNote').value = '';
  document.querySelector('input[name="dateMode"][value="date"]').checked = true;
  updateDateMode();
  state.pendingOrder = null;
}

function addItem(data = null) {
  const fragment = byId('itemTemplate').content.cloneNode(true);
  const card = fragment.querySelector('.item-card');
  const select = fragment.querySelector('.product-select');
  const unit = fragment.querySelector('.unit-input');
  const otherField = fragment.querySelector('.other-name-field');
  const otherInput = fragment.querySelector('.other-name-input');

  state.products.forEach(p => {
    const option = document.createElement('option');
    option.value = p.productCode;
    option.textContent = p.displayName || p.productName;
    option.dataset.productName = p.productName;
    option.dataset.defaultUnit = p.defaultUnit || 'kg';
    select.appendChild(option);
  });
  const other = document.createElement('option');
  other.value = 'OTHER';
  other.textContent = 'その他（商品名を入力）';
  select.appendChild(other);

  select.onchange = () => {
    const isOther = select.value === 'OTHER';
    otherField.classList.toggle('hidden', !isOther);
    otherInput.required = isOther;
    if (!isOther) unit.value = select.options[select.selectedIndex]?.dataset.defaultUnit || '';
  };
  fragment.querySelector('.remove-item-button').onclick = () => {
    if (document.querySelectorAll('.item-card').length <= 1) return alert('商品は1件以上必要です。');
    card.remove();
    renumber();
  };

  byId('itemsContainer').appendChild(fragment);
  if (data) {
    const exists = [...select.options].some(x => x.value === data.productCode);
    select.value = exists ? (data.productCode || '') : 'OTHER';
    if (select.value === 'OTHER') {
      otherField.classList.remove('hidden');
      otherInput.required = true;
      otherInput.value = data.productName || '';
    }
    unit.value = data.unit || select.options[select.selectedIndex]?.dataset.defaultUnit || '';
    card.querySelector('.quantity-input').value = data.quantity ?? '';
    card.querySelector('.item-note-input').value = data.note || '';
  }
  renumber();
}

function updateDateMode() {
  const mode = document.querySelector('input[name="dateMode"]:checked')?.value || 'date';
  byId('deliveryDateField').classList.toggle('hidden', mode === 'text');
  byId('deliveryConditionField').classList.toggle('hidden', mode === 'date');
}

function collectOrder() {
  const mode = document.querySelector('input[name="dateMode"]:checked')?.value || 'date';
  const date = byId('deliveryDate').value.trim();
  const condition = byId('deliveryCondition').value.trim();
  if (mode === 'date' && !date) throw new Error('希望日を選択してください。');
  if (mode === 'text' && !condition) throw new Error('希望条件を入力してください。');
  if (mode === 'both' && (!date || !condition)) throw new Error('希望日と希望条件を入力してください。');
  const receiveMethod = document.querySelector('input[name="receiveMethod"]:checked')?.value || '';
  if (!receiveMethod) throw new Error('受取方法を選択してください。');

  const items = [...document.querySelectorAll('.item-card')].map((card, i) => {
    const select = card.querySelector('.product-select');
    const quantity = Number(card.querySelector('.quantity-input').value);
    const unit = card.querySelector('.unit-input').value.trim();
    if (!select.value) throw new Error(`${i + 1}件目の商品を選択してください。`);
    const isOther = select.value === 'OTHER';
    const productName = isOther
      ? card.querySelector('.other-name-input').value.trim()
      : (select.options[select.selectedIndex].dataset.productName || select.options[select.selectedIndex].textContent);
    if (!productName) throw new Error(`${i + 1}件目の商品名を入力してください。`);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`${i + 1}件目の数量を正しく入力してください。`);
    if (!unit) throw new Error(`${i + 1}件目の単位を入力してください。`);
    return { productCode: select.value, productName, quantity, unit, note: card.querySelector('.item-note-input').value.trim(), isOther };
  });

  return {
    deliveryDate: date,
    deliveryCondition: condition,
    dateMode: mode,
    receiveMethod,
    preferredTime: byId('preferredTime').value,
    orderNote: byId('orderNote').value.trim(),
    items,
    reorderSourceId: state.pendingOrder?.reorderSourceId || ''
  };
}

function collectDraft() {
  try { return collectOrder(); } catch (_) {
    const mode = document.querySelector('input[name="dateMode"]:checked')?.value || 'date';
    const items = [...document.querySelectorAll('.item-card')].map(card => {
      const select = card.querySelector('.product-select');
      const isOther = select.value === 'OTHER';
      return {
        productCode: select.value,
        productName: isOther ? card.querySelector('.other-name-input').value.trim() : (select.options[select.selectedIndex]?.dataset.productName || ''),
        quantity: card.querySelector('.quantity-input').value,
        unit: card.querySelector('.unit-input').value.trim(),
        note: card.querySelector('.item-note-input').value.trim(),
        isOther
      };
    });
    return {
      deliveryDate: byId('deliveryDate').value.trim(),
      deliveryCondition: byId('deliveryCondition').value.trim(),
      dateMode: mode,
      receiveMethod: document.querySelector('input[name="receiveMethod"]:checked')?.value || '',
      preferredTime: byId('preferredTime').value,
      orderNote: byId('orderNote').value.trim(),
      items,
      reorderSourceId: state.pendingOrder?.reorderSourceId || ''
    };
  }
}

function applyOrderToForm(order) {
  byId('itemsContainer').innerHTML = '';
  const items = Array.isArray(order.items) && order.items.length ? order.items : [null];
  items.forEach(item => addItem(item));
  byId('deliveryDate').value = order.deliveryDate || '';
  byId('deliveryCondition').value = order.deliveryCondition || '';
  byId('preferredTime').value = order.preferredTime || '';
  byId('orderNote').value = order.orderNote || '';
  const mode = order.dateMode || (order.deliveryDate && order.deliveryCondition ? 'both' : order.deliveryCondition ? 'text' : 'date');
  const dateMode = document.querySelector(`input[name="dateMode"][value="${mode}"]`);
  if (dateMode) dateMode.checked = true;
  updateDateMode();
  const receive = [...document.querySelectorAll('input[name="receiveMethod"]')].find(x => x.value === order.receiveMethod);
  if (receive) receive.checked = true;
  state.pendingOrder = { reorderSourceId: order.reorderSourceId || '' };
}


function collectFavoriteItems() {
  return [...document.querySelectorAll('.item-card')].map((card, i) => {
    const select = card.querySelector('.product-select');
    const quantity = Number(card.querySelector('.quantity-input').value);
    const unit = card.querySelector('.unit-input').value.trim();
    if (!select.value) throw new Error(`${i + 1}件目の商品を選択してください。`);
    const isOther = select.value === 'OTHER';
    const productName = isOther
      ? card.querySelector('.other-name-input').value.trim()
      : (select.options[select.selectedIndex].dataset.productName || select.options[select.selectedIndex].textContent);
    if (!productName) throw new Error(`${i + 1}件目の商品名を入力してください。`);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`${i + 1}件目の数量を正しく入力してください。`);
    if (!unit) throw new Error(`${i + 1}件目の単位を入力してください。`);
    return { productCode: select.value, productName, quantity, unit, note: card.querySelector('.item-note-input').value.trim(), isOther };
  });
}

async function saveCurrentItemsAsFavorite() {
  try {
    const items = collectFavoriteItems();
    const setName = prompt('お気に入りセット名を入力してください。（最大30文字）');
    if (setName === null) return;
    const result = await postAction('saveFavorite', { payload: JSON.stringify({ setName: setName.trim(), items }) });
    if (!result.ok) throw new Error(result.error || 'お気に入りセットを保存できませんでした。');
    state.favorites.unshift(result.favorite);
    state.favorites = state.favorites.filter((x, i, a) => x && a.findIndex(y => y.favoriteId === x.favoriteId) === i);
    renderFavorites();
    alert('お気に入りセットを保存しました。');
  } catch (err) {
    alert(err.message || String(err));
  }
}

function renderFavorites() {
  const list = byId('favoriteList');
  if (!list) return;
  list.innerHTML = '';
  if (!state.favorites.length) {
    list.innerHTML = '<div class="center-card compact"><p>お気に入りセットはまだありません。<br>発注画面で商品と数量を入力し、「現在の商品をお気に入りセットに保存」を押してください。</p></div>';
    return;
  }
  state.favorites.forEach(favorite => {
    const card = document.createElement('article');
    card.className = 'favorite-card';
    card.innerHTML = `<h3>${escapeHtml(favorite.setName)}</h3>
      <div class="favorite-meta">更新：${escapeHtml(favorite.updatedByName || favorite.createdByName || '')} ${escapeHtml(favorite.updatedAt || favorite.createdAt || '')}</div>
      <ul class="favorite-items">${(favorite.items || []).map(x => `<li>${escapeHtml(x.productName)}　${escapeHtml(x.quantity)} ${escapeHtml(x.unit)}</li>`).join('')}</ul>
      <div class="favorite-actions">
        <button class="button button-primary apply" type="button">発注に反映</button>
        <button class="button button-secondary overwrite" type="button">現在の商品で上書き</button>
        <button class="button button-secondary delete" type="button">削除</button>
      </div>`;
    card.querySelector('.apply').onclick = () => applyFavorite(favorite);
    card.querySelector('.overwrite').onclick = () => overwriteFavorite(favorite);
    card.querySelector('.delete').onclick = () => removeFavorite(favorite);
    list.appendChild(card);
  });
}

function applyFavorite(favorite) {
  byId('itemsContainer').innerHTML = '';
  (favorite.items || []).forEach(item => addItem(item));
  if (!(favorite.items || []).length) addItem();
  switchTab('new');
  scrollTo(0, 0);
  alert(`「${favorite.setName}」を発注画面に反映しました。希望日と受取方法を入力してください。`);
}

async function overwriteFavorite(favorite) {
  try {
    const items = collectFavoriteItems();
    const setName = prompt('セット名を確認・変更してください。', favorite.setName);
    if (setName === null) return;
    if (!confirm(`「${setName.trim()}」を現在の商品内容で上書きしますか？`)) return;
    const result = await postAction('saveFavorite', { payload: JSON.stringify({ favoriteId: favorite.favoriteId, setName: setName.trim(), items }) });
    if (!result.ok) throw new Error(result.error || 'お気に入りセットを更新できませんでした。');
    state.favorites = state.favorites.map(x => x.favoriteId === favorite.favoriteId ? result.favorite : x);
    renderFavorites();
    alert('お気に入りセットを更新しました。');
  } catch (err) {
    alert(err.message || String(err));
  }
}

async function removeFavorite(favorite) {
  if (!confirm(`「${favorite.setName}」を削除しますか？`)) return;
  try {
    const result = await postAction('deleteFavorite', { favoriteId: favorite.favoriteId });
    if (!result.ok) throw new Error(result.error || 'お気に入りセットを削除できませんでした。');
    state.favorites = state.favorites.filter(x => x.favoriteId !== favorite.favoriteId);
    renderFavorites();
  } catch (err) {
    alert(err.message || String(err));
  }
}

async function saveDraft() {
  const button = byId('saveDraftButton');
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    const result = await postAction('saveDraft', { payload: JSON.stringify(collectDraft()) });
    if (!result.ok) throw new Error(result.error || '下書きを保存できませんでした。');
    byId('draftNoticeText').textContent = `${result.savedAt || '現在'} に下書きを保存しました。`;
    byId('draftNotice').classList.remove('hidden');
  } catch (err) {
    alert(err.message || String(err));
  } finally {
    button.disabled = false;
    button.textContent = '下書き保存';
  }
}

async function deleteDraft() {
  if (!confirm('保存した下書きを削除しますか？')) return;
  try {
    const result = await postAction('deleteDraft');
    if (!result.ok) throw new Error(result.error || '下書きを削除できませんでした。');
    byId('draftNotice').classList.add('hidden');
  } catch (err) {
    alert(err.message || String(err));
  }
}

function showConfirmation(e) {
  e.preventDefault();
  try {
    state.pendingOrder = collectOrder();
    const order = state.pendingOrder;
    const items = order.items.map((x, i) =>
      `<div class="summary-card"><h2>商品 ${i + 1}</h2><dl>${row('商品', x.productName)}${row('数量', `${x.quantity} ${x.unit}`)}${row('備考', x.note || 'なし')}</dl></div>`
    ).join('');
    byId('confirmationContent').innerHTML =
      `<div class="summary-card"><dl>${row('取引先', state.customer.customerName)}${row('希望日', order.deliveryDate || '指定なし')}${row('希望条件', order.deliveryCondition || 'なし')}${row('受取方法', order.receiveMethod)}${row('時間帯', order.preferredTime || '指定なし')}${row('備考', order.orderNote || 'なし')}</dl></div>${items}`;
    showOnly('confirmView');
    scrollTo(0, 0);
  } catch (err) {
    alert(err.message);
  }
}

async function loadHistory(reset) {
  if (state.historyLoading) return;
  state.historyLoading = true;
  const requestId = ++state.historyRequestId;
  byId('historyLoading').classList.remove('hidden');
  byId('historySearchButton').disabled = true;
  byId('loadMoreHistoryButton').disabled = true;

  try {
    if (reset) {
      state.historyPage = 0;
      state.renderedOrderIds.clear();
      byId('historyList').innerHTML = '';
    }
    const page = state.historyPage + 1;
    const data = await jsonp('history', {
      idToken: state.idToken,
      page: String(page),
      pageSize: '20',
      keyword: byId('historyKeyword').value.trim()
    });
    if (requestId !== state.historyRequestId) return;
    if (!data.ok) throw new Error(data.error || '履歴を取得できません。');

    const uniqueOrders = [];
    for (const order of (data.orders || [])) {
      const key = String(order.orderId || '');
      if (!key || state.renderedOrderIds.has(key)) continue;
      state.renderedOrderIds.add(key);
      uniqueOrders.push(order);
    }
    uniqueOrders.forEach(renderHistoryCard);

    state.historyPage = page;
    state.historyHasMore = Boolean(data.hasMore);
    byId('loadMoreHistoryButton').classList.toggle('hidden', !state.historyHasMore);
    if (reset && !uniqueOrders.length) {
      byId('historyList').innerHTML = '<div class="center-card compact"><p>該当する注文履歴はありません。</p></div>';
    }
  } catch (e) {
    alert(e.message || String(e));
  } finally {
    if (requestId === state.historyRequestId) {
      state.historyLoading = false;
      byId('historyLoading').classList.add('hidden');
      byId('historySearchButton').disabled = false;
      byId('loadMoreHistoryButton').disabled = false;
    }
  }
}

function renderHistoryCard(order) {
  const card = document.createElement('article');
  card.className = 'history-card';
  card.dataset.orderId = order.orderId;
  card.innerHTML = `<h3>${escapeHtml(order.orderId)}</h3>
    <div class="history-meta">${escapeHtml(order.createdAt)}／${escapeHtml(order.status || '')}${order.memberName ? `／担当：${escapeHtml(order.memberName)}` : ''}</div>
    <div>${escapeHtml(order.deliveryDate || order.deliveryCondition || '希望日未指定')}・${escapeHtml(order.receiveMethod || '')}</div>
    <ul class="history-items">${(order.items || []).map(x => `<li>${escapeHtml(x.productName)}　${escapeHtml(x.quantity)} ${escapeHtml(x.unit)}</li>`).join('')}</ul>
    <div class="history-actions"><button class="button button-secondary same">同じ内容で再発注</button><button class="button button-primary edit">内容を変更して再発注</button></div>`;
  card.querySelector('.same').onclick = () => copyHistoryToForm(order, false);
  card.querySelector('.edit').onclick = () => copyHistoryToForm(order, true);
  byId('historyList').appendChild(card);
}

function copyHistoryToForm(order, editable) {
  applyOrderToForm({ ...order, deliveryDate: '', deliveryCondition: '', reorderSourceId: order.orderId });
  switchTab('new');
  scrollTo(0, 0);
  alert(editable ? '過去の内容を入力しました。必要な箇所を修正してください。' : '過去の内容を入力しました。希望日を指定して発注してください。');
}

function submitOrder() {
  const button = byId('submitButton');
  button.disabled = true;
  button.textContent = '送信しています…';
  postViaIframe('submitOrder', { payload: JSON.stringify(state.pendingOrder) });
  clearTimeout(submitTimer);
  submitTimer = setTimeout(() => {
    button.disabled = false;
    button.textContent = 'この内容で発注する';
    alert('注文送信がタイムアウトしました。');
  }, 30000);
}

function postAction(action, extra = {}) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Apps Scriptとの通信がタイムアウトしました。'));
    }, 30000);
    function handler(e) {
      if (!e.data || e.data.source !== 'MeatFlowAppsScript' || e.data.action !== action) return;
      clearTimeout(timeoutId);
      window.removeEventListener('message', handler);
      resolve(e.data);
    }
    window.addEventListener('message', handler);
    postViaIframe(action, extra);
  });
}

function postViaIframe(action, extra = {}) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = CONFIG.GAS_WEB_APP_URL;
  form.target = 'submitFrame';
  form.className = 'hidden';
  const fields = { action, idToken: state.idToken, origin: location.origin, ...extra };
  Object.entries(fields).forEach(([name, value]) => {
    const input = document.createElement('input');
    input.name = name;
    input.value = value ?? '';
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

function receiveSubmitResult(e) {
  if (!e.data || e.data.source !== 'MeatFlowAppsScript' || e.data.action !== 'submitOrder') return;
  clearTimeout(submitTimer);
  const button = byId('submitButton');
  button.disabled = false;
  button.textContent = 'この内容で発注する';
  if (!e.data.ok) return alert(e.data.error || '注文を保存できませんでした。');
  byId('completedOrderId').textContent = e.data.orderId;
  byId('draftNotice').classList.add('hidden');
  state.historyPage = 0;
  state.renderedOrderIds.clear();
  showOnly('completeView');
}

function jsonp(action, params = {}) {
  return new Promise((resolve, reject) => {
    const callback = `__mf${++jsonpCounter}`;
    const script = document.createElement('script');
    const timeoutId = setTimeout(() => done(new Error('Apps Scriptとの通信がタイムアウトしました。')), 20000);
    function done(err, value) {
      clearTimeout(timeoutId);
      delete window[callback];
      script.remove();
      err ? reject(err) : resolve(value);
    }
    window[callback] = value => done(null, value);
    script.onerror = () => done(new Error('Apps Script APIを読み込めませんでした。'));
    const url = new URL(CONFIG.GAS_WEB_APP_URL);
    url.searchParams.set('action', action);
    url.searchParams.set('callback', callback);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    url.searchParams.set('_', Date.now().toString());
    script.src = url;
    document.head.appendChild(script);
  });
}

function validateConfig() {
  if (!CONFIG.LIFF_ID || !CONFIG.GAS_WEB_APP_URL) throw new Error('config.jsの設定が不足しています。');
}
function showOnly(id) {
  ['loadingView', 'errorView', 'registrationView', 'pendingView', 'mainView', 'confirmView', 'completeView']
    .forEach(x => byId(x).classList.toggle('hidden', x !== id));
}
function byId(id) { return document.getElementById(id); }
function renumber() { document.querySelectorAll('.item-card').forEach((x, i) => x.querySelector('.item-number').textContent = `商品 ${i + 1}`); }
function row(label, value) { return `<div class="summary-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`; }
function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
function timeout(promise, ms, message) { return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]); }
function setMinimumDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  byId('deliveryDate').min = local.toISOString().slice(0, 10);
}
