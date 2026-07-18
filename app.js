'use strict';
const CONFIG=window.MEATFLOW_CONFIG||{};
const state={profile:null,idToken:'',customer:null,products:[],pendingOrder:null,historyPage:0,historyHasMore:false};
let jsonpCounter=0,submitTimer=null;

document.addEventListener('DOMContentLoaded',()=>{
  byId('retryButton').onclick=initializeApp;
  byId('addItemButton').onclick=()=>addItem();
  byId('orderForm').onsubmit=showConfirmation;
  byId('editButton').onclick=()=>showOnly('mainView');
  byId('submitButton').onclick=submitOrder;
  byId('closeButton').onclick=()=>{if(liff.isInClient())liff.closeWindow()};
  byId('newOrderTab').onclick=()=>switchTab('new');
  byId('historyTab').onclick=()=>switchTab('history');
  byId('historySearchButton').onclick=()=>loadHistory(true);
  byId('loadMoreHistoryButton').onclick=()=>loadHistory(false);
  document.querySelectorAll('input[name="dateMode"]').forEach(x=>x.onchange=updateDateMode);
  window.addEventListener('message',receiveSubmitResult);
  initializeApp();
});

async function initializeApp(){
  showOnly('loadingView');
  try{
    validateConfig();
    await timeout(liff.init({liffId:CONFIG.LIFF_ID}),15000,'LIFF初期化がタイムアウトしました。');
    if(!liff.isLoggedIn()){liff.login({redirectUri:location.href.split('#')[0]});return}
    state.profile=await liff.getProfile(); state.idToken=liff.getIDToken();
    if(!state.idToken)throw new Error('LINE IDトークンを取得できません。');
    const data=await jsonp('bootstrap',{idToken:state.idToken});
    if(!data.ok)throw new Error(data.error||'初期データを取得できません。');
    state.customer=data.customer; state.products=data.products||[];
    if(!state.customer?.registered)throw new Error('このLINEアカウントは取引先登録されていません。');
    byId('customerName').textContent=state.customer.customerName||'取引先';
    renderReceiveMethods();
    setMinimumDate();
    byId('itemsContainer').innerHTML=''; addItem();
    showOnly('mainView'); switchTab('new');
  }catch(e){byId('errorMessage').textContent=e.message||String(e);showOnly('errorView')}
}

function switchTab(tab){
  const isNew=tab==='new';
  byId('newOrderPanel').classList.toggle('hidden',!isNew);
  byId('historyPanel').classList.toggle('hidden',isNew);
  byId('newOrderTab').classList.toggle('active',isNew);
  byId('historyTab').classList.toggle('active',!isNew);
  byId('screenTitle').textContent=isNew?'新規発注':'注文履歴';
  if(!isNew&&state.historyPage===0)loadHistory(true);
}

function renderReceiveMethods(){
  const c=state.customer,area=byId('receiveMethodArea'); area.innerHTML='';
  const options=[];
  if(c.deliveryAllowed)options.push(['配送希望','配送希望','※ 配送日時は、ご希望に添えない場合があります。']);
  if(c.pickupAllowed)options.push(['店舗受取（担たん亭でのお受け取り）','店舗受取','担たん亭でのお受け取り']);
  options.forEach(([v,title,small])=>{
    const label=document.createElement('label'); label.className='radio-card';
    label.innerHTML=`<input type="radio" name="receiveMethod" value="${escapeHtml(v)}"><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(small)}</small></span>`;
    area.appendChild(label);
  });
  if(c.receiveMode==='固定'&&c.defaultReceiveMethod){
    const target=[...area.querySelectorAll('input')].find(x=>x.value===c.defaultReceiveMethod);
    if(target){target.checked=true;area.querySelectorAll('input').forEach(x=>x.disabled=true)}
  }else if(c.defaultReceiveMethod){
    const target=[...area.querySelectorAll('input')].find(x=>x.value===c.defaultReceiveMethod); if(target)target.checked=true;
  }
}

function addItem(data=null){
  const f=byId('itemTemplate').content.cloneNode(true),card=f.querySelector('.item-card');
  const select=f.querySelector('.product-select'),unit=f.querySelector('.unit-input'),otherField=f.querySelector('.other-name-field'),otherInput=f.querySelector('.other-name-input');
  state.products.forEach(p=>{
    const o=document.createElement('option');o.value=p.productCode;o.textContent=p.displayName||p.productName;
    o.dataset.productName=p.productName;o.dataset.displayName=p.displayName||p.productName;o.dataset.defaultUnit=p.defaultUnit||'kg';select.appendChild(o)
  });
  const other=document.createElement('option');other.value='OTHER';other.textContent='その他（商品名を入力）';select.appendChild(other);
  select.onchange=()=>{
    const isOther=select.value==='OTHER';otherField.classList.toggle('hidden',!isOther);
    otherInput.required=isOther;
    if(!isOther)unit.value=select.options[select.selectedIndex]?.dataset.defaultUnit||'';
  };
  f.querySelector('.remove-item-button').onclick=()=>{if(document.querySelectorAll('.item-card').length<=1)return alert('商品は1件以上必要です。');card.remove();renumber()};
  byId('itemsContainer').appendChild(f);
  if(data){
    select.value=data.productCode||'';
    if(data.productCode==='OTHER'){otherField.classList.remove('hidden');otherInput.required=true;otherInput.value=data.productName||''}
    unit.value=data.unit||select.options[select.selectedIndex]?.dataset.defaultUnit||'';
    card.querySelector('.quantity-input').value=data.quantity||'';
    card.querySelector('.item-note-input').value=data.note||'';
  }
  renumber();
}

function updateDateMode(){
  const mode=document.querySelector('input[name="dateMode"]:checked').value;
  byId('deliveryDateField').classList.toggle('hidden',mode==='text');
  byId('deliveryConditionField').classList.toggle('hidden',mode==='date');
}
function collectOrder(){
  const mode=document.querySelector('input[name="dateMode"]:checked').value;
  const date=byId('deliveryDate').value.trim(),condition=byId('deliveryCondition').value.trim();
  if(mode==='date'&&!date)throw new Error('希望日を選択してください。');
  if(mode==='text'&&!condition)throw new Error('希望条件を入力してください。');
  if(mode==='both'&&(!date||!condition))throw new Error('希望日と希望条件を入力してください。');
  const receive=document.querySelector('input[name="receiveMethod"]:checked')?.value||'';
  if(!receive)throw new Error('受取方法を選択してください。');
  const items=[...document.querySelectorAll('.item-card')].map((card,i)=>{
    const s=card.querySelector('.product-select'),q=Number(card.querySelector('.quantity-input').value),u=card.querySelector('.unit-input').value.trim();
    if(!s.value)throw new Error(`${i+1}件目の商品を選択してください。`);
    const isOther=s.value==='OTHER';
    const name=isOther?card.querySelector('.other-name-input').value.trim():(s.options[s.selectedIndex].dataset.productName||s.options[s.selectedIndex].textContent);
    if(!name)throw new Error(`${i+1}件目の商品名を入力してください。`);
    if(!Number.isFinite(q)||q<=0)throw new Error(`${i+1}件目の数量を正しく入力してください。`);
    if(!u)throw new Error(`${i+1}件目の単位を入力してください。`);
    return{productCode:s.value,productName:name,quantity:q,unit:u,note:card.querySelector('.item-note-input').value.trim(),isOther}
  });
  return{deliveryDate:date,deliveryCondition:condition,dateMode:mode,receiveMethod:receive,preferredTime:byId('preferredTime').value,orderNote:byId('orderNote').value.trim(),items,reorderSourceId:state.pendingOrder?.reorderSourceId||''}
}

function showConfirmation(e){e.preventDefault();try{
  state.pendingOrder=collectOrder();const o=state.pendingOrder;
  const items=o.items.map((x,i)=>`<div class="summary-card"><h2>商品 ${i+1}</h2><dl>${row('商品',x.productName)}${row('数量',`${x.quantity} ${x.unit}`)}${row('備考',x.note||'なし')}</dl></div>`).join('');
  byId('confirmationContent').innerHTML=`<div class="summary-card"><dl>${row('取引先',state.customer.customerName)}${row('希望日',o.deliveryDate||'指定なし')}${row('希望条件',o.deliveryCondition||'なし')}${row('受取方法',o.receiveMethod)}${row('時間帯',o.preferredTime||'指定なし')}${row('備考',o.orderNote||'なし')}</dl></div>${items}`;
  showOnly('confirmView');scrollTo(0,0)
}catch(err){alert(err.message)}}

async function loadHistory(reset){
  try{
    if(reset){state.historyPage=0;byId('historyList').innerHTML=''}
    const page=state.historyPage+1;
    const data=await jsonp('history',{idToken:state.idToken,page:String(page),pageSize:'20',keyword:byId('historyKeyword').value.trim()});
    if(!data.ok)throw new Error(data.error||'履歴を取得できません。');
    data.orders.forEach(renderHistoryCard);
    state.historyPage=page;state.historyHasMore=data.hasMore;
    byId('loadMoreHistoryButton').classList.toggle('hidden',!data.hasMore);
    if(reset&&!data.orders.length)byId('historyList').innerHTML='<div class="center-card"><p>該当する注文履歴はありません。</p></div>';
  }catch(e){alert(e.message)}
}
function renderHistoryCard(o){
  const card=document.createElement('article');card.className='history-card';
  card.innerHTML=`<h3>${escapeHtml(o.orderId)}</h3><div class="history-meta">${escapeHtml(o.createdAt)}／${escapeHtml(o.status||'')}</div>
    <div>${escapeHtml(o.deliveryDate||o.deliveryCondition||'希望日未指定')}・${escapeHtml(o.receiveMethod||'')}</div>
    <ul class="history-items">${o.items.map(x=>`<li>${escapeHtml(x.productName)}　${escapeHtml(x.quantity)} ${escapeHtml(x.unit)}</li>`).join('')}</ul>
    <div class="history-actions"><button class="button button-secondary same">同じ内容で再発注</button><button class="button button-primary edit">内容を変更して再発注</button></div>`;
  card.querySelector('.same').onclick=()=>copyHistoryToForm(o,false);
  card.querySelector('.edit').onclick=()=>copyHistoryToForm(o,true);
  byId('historyList').appendChild(card);
}
function copyHistoryToForm(o,editable){
  byId('itemsContainer').innerHTML='';
  o.items.forEach(x=>addItem(x));
  byId('deliveryDate').value='';byId('deliveryCondition').value='';
  byId('preferredTime').value=o.preferredTime||'';
  byId('orderNote').value=o.orderNote||'';
  const r=[...document.querySelectorAll('input[name="receiveMethod"]')].find(x=>x.value===o.receiveMethod);if(r&&!r.disabled)r.checked=true;
  state.pendingOrder={reorderSourceId:o.orderId};
  switchTab('new');scrollTo(0,0);
  alert(editable?'過去の内容を入力しました。必要な箇所を修正してください。':'過去の内容を入力しました。希望日を指定して発注してください。');
}

function submitOrder(){
  const b=byId('submitButton');b.disabled=true;b.textContent='送信しています…';
  const form=document.createElement('form');form.method='POST';form.action=CONFIG.GAS_WEB_APP_URL;form.target='submitFrame';form.className='hidden';
  const fields={action:'submitOrder',idToken:state.idToken,payload:JSON.stringify(state.pendingOrder),origin:location.origin};
  Object.entries(fields).forEach(([n,v])=>{const i=document.createElement('input');i.name=n;i.value=v;form.appendChild(i)});
  document.body.appendChild(form);form.submit();form.remove();
  clearTimeout(submitTimer);submitTimer=setTimeout(()=>{b.disabled=false;b.textContent='この内容で発注する';alert('注文送信がタイムアウトしました。')},30000)
}
function receiveSubmitResult(e){
  if(!e.data||e.data.source!=='MeatFlowAppsScript')return;
  clearTimeout(submitTimer);const b=byId('submitButton');b.disabled=false;b.textContent='この内容で発注する';
  if(!e.data.ok)return alert(e.data.error||'注文を保存できませんでした。');
  byId('completedOrderId').textContent=e.data.orderId;showOnly('completeView')
}
function jsonp(action,params={}){
  return new Promise((resolve,reject)=>{
    const cb='__mf'+(++jsonpCounter),s=document.createElement('script'),t=setTimeout(()=>done(new Error('Apps Scriptとの通信がタイムアウトしました。')),20000);
    function done(err,val){clearTimeout(t);delete window[cb];s.remove();err?reject(err):resolve(val)}
    window[cb]=v=>done(null,v);s.onerror=()=>done(new Error('Apps Script APIを読み込めませんでした。'));
    const u=new URL(CONFIG.GAS_WEB_APP_URL);u.searchParams.set('action',action);u.searchParams.set('callback',cb);Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,v));s.src=u;document.head.appendChild(s)
  })
}
function validateConfig(){if(!CONFIG.LIFF_ID||!CONFIG.GAS_WEB_APP_URL)throw new Error('config.jsの設定が不足しています。')}
function showOnly(id){['loadingView','errorView','mainView','confirmView','completeView'].forEach(x=>byId(x).classList.toggle('hidden',x!==id))}
function byId(x){return document.getElementById(x)}function renumber(){document.querySelectorAll('.item-card').forEach((x,i)=>x.querySelector('.item-number').textContent=`商品 ${i+1}`)}
function row(a,b){return `<div class="summary-row"><dt>${escapeHtml(a)}</dt><dd>${escapeHtml(b)}</dd></div>`}
function escapeHtml(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;')}
function timeout(p,ms,msg){return Promise.race([p,new Promise((_,r)=>setTimeout(()=>r(new Error(msg)),ms))])}
function setMinimumDate(){const d=new Date(),l=new Date(d.getTime()-d.getTimezoneOffset()*60000);byId('deliveryDate').min=l.toISOString().slice(0,10)}
