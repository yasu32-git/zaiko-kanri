import { DB, logKey } from './db.js';

// ---------------------------------------------------------------- 状態

const state = {
  items: [],
  logs: [],
  stores: [],
  view: 'list',          // 'list' | 'shopping'
  storeFilter: null,     // null = すべて
  apiUrl: '',
  apiKey: '',
  syncing: false
};

const $ = sel => document.querySelector(sel);
const nowIso = () => new Date().toISOString();
const newId = () => 'itm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
const fmtNum = n => (Math.round(n * 10) / 10).toString();

// ---------------------------------------------------------------- 起動

init();

async function init() {
  state.apiUrl = await DB.getMeta('apiUrl', '');
  state.apiKey = await DB.getMeta('apiKey', '');

  state.items = await DB.getAll('items');
  state.logs = await DB.getAll('logs');
  state.stores = await DB.getMeta('stores', []);

  // 保存処理などは非同期なので、握り潰さずステータス行に出す
  window.addEventListener('unhandledrejection', ev => {
    setStatus('エラー: ' + (ev.reason?.message || ev.reason), true);
  });

  bindUI();
  render();

  if (!state.apiUrl) {
    setStatus('GASのURLが未設定です。右上の⚙から設定してください。', true);
    openSettings();
  } else {
    sync();
  }

  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ---------------------------------------------------------------- 同期

async function sync() {
  if (state.syncing || !state.apiUrl) return;
  if (!navigator.onLine) { setStatus('オフライン（変更は復帰時に送信します）'); return; }

  state.syncing = true;
  $('#btnSync').classList.add('spin');
  setStatus('同期中…');

  try {
    const queue = await DB.takeQueue();
    const seqs = queue.map(q => q.seq);

    // 同一品目の更新は最後のものだけ送れば十分
    const itemMap = new Map();
    const logs = [];
    for (const q of queue) {
      if (q.kind === 'item') itemMap.set(q.payload.id, q.payload);
      else if (q.kind === 'log') logs.push(q.payload);
    }
    const items = [...itemMap.values()];

    const res = await post('sync', { items, logs });
    await DB.removeQueue(seqs);
    await applyServerData(res.data);

    await DB.setMeta('lastSync', nowIso());
    setStatus('最終同期 ' + new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
  } catch (e) {
    setStatus('同期できませんでした: ' + e.message, true);
  } finally {
    state.syncing = false;
    $('#btnSync').classList.remove('spin');
    render();
    updateBadge();
  }
}

/** サーバから返った全件を Last-Write-Wins でローカルへ反映 */
async function applyServerData(data) {
  const localById = new Map(state.items.map(i => [i.id, i]));
  const merged = data.items.map(srv => {
    const loc = localById.get(srv.id);
    // 送信直後にローカルで編集された場合のみローカルを優先
    if (loc && loc.updatedAt && srv.updatedAt && loc.updatedAt > srv.updatedAt) return loc;
    return srv;
  });

  // サーバに存在しないローカル品目（送信待ちで作られた直後など）は残す
  const srvIds = new Set(data.items.map(i => i.id));
  for (const loc of state.items) if (!srvIds.has(loc.id)) merged.push(loc);

  state.items = merged;
  state.logs = data.logs.map(l => ({ ...l, key: logKey(l.itemId, l.at) }));
  state.stores = data.stores.map(s => s.name);

  await DB.clear('items');
  await DB.putAll('items', state.items);
  await DB.clear('logs');
  await DB.putAll('logs', state.logs);
  await DB.setMeta('stores', state.stores);
}

function post(action, payload) {
  // Content-Type を指定しない＝text/plain となり、CORSプリフライトが発生しない
  return fetch(state.apiUrl, {
    method: 'POST',
    body: JSON.stringify({ key: state.apiKey, action, payload }),
    redirect: 'follow'
  })
    .then(r => r.json())
    .then(j => {
      if (!j.ok) throw new Error(j.error || 'サーバエラー');
      return j.data;
    });
}

async function updateBadge() {
  const q = await DB.takeQueue();
  const badge = $('#syncBadge');
  badge.textContent = q.length;
  badge.hidden = q.length === 0;
}

// ---------------------------------------------------------------- データ操作

/** 品目をローカルに反映し、送信キューに積む（オンラインなら即同期） */
async function saveItem(item, { immediateSync = true } = {}) {
  item.updatedAt = nowIso();
  const idx = state.items.findIndex(i => i.id === item.id);
  if (idx >= 0) state.items[idx] = item; else state.items.push(item);

  await DB.put('items', item);
  await DB.enqueue('item', item);
  render();
  updateBadge();
  if (immediateSync) sync();
}

async function addLog(log) {
  log.key = logKey(log.itemId, log.at);
  state.logs.push(log);
  await DB.put('logs', log);
  await DB.enqueue('log', log);
}

/** 在庫を増減。0になったら自動で「必須」＋買い物リスト入り */
async function changeStock(item, delta) {
  const next = { ...item, stock: Math.max(0, item.stock + delta) };
  if (next.stock === 0 && item.stock > 0) {
    next.urgency = '必須';
    next.onList = true;
  }
  await saveItem(next);
}

async function toggleList(item) {
  const next = { ...item, onList: !item.onList };
  if (!next.onList && next.urgency === '必須' && next.stock > 0) next.urgency = '通常';
  await saveItem(next);
}

/** 購入済み: リストから外し、在庫を加算し、履歴を記録 */
async function markPurchased(item, qty, store) {
  const stockAfter = item.stock + qty;
  await addLog({
    at: nowIso(),
    itemId: item.id,
    name: item.name,
    qty,
    store: store || '',
    stockAfter
  });
  await saveItem({ ...item, stock: stockAfter, onList: false, urgency: '通常', dueDate: '' });
}

// ---------------------------------------------------------------- 消費ペース

/**
 * 購入履歴から1日あたりの消費量を推定する。
 * 「最初の購入から最後の購入までの期間に、最後の購入を除く購入分を消費した」とみなす。
 * 購入が2回未満の品目は推定不能（null）。
 */
function estimatePace(itemId) {
  const logs = state.logs
    .filter(l => l.itemId === itemId)
    .sort((a, b) => a.at.localeCompare(b.at));
  if (logs.length < 2) return null;

  const spanMs = new Date(logs[logs.length - 1].at) - new Date(logs[0].at);
  const days = spanMs / 86400000;
  if (days < 1) return null;

  const consumed = logs.slice(0, -1).reduce((s, l) => s + l.qty, 0);
  if (consumed <= 0) return null;

  return consumed / days; // 1日あたりの消費量
}

function paceLabel(item) {
  const pace = estimatePace(item.id);
  if (!pace) return '';
  const daysLeft = item.stock / pace;
  if (!isFinite(daysLeft)) return '';
  if (daysLeft < 1) return '残り1日未満';
  if (daysLeft < 60) return `残り約${Math.round(daysLeft)}日`;
  return `残り約${Math.round(daysLeft / 30)}ヶ月`;
}

function dueLabel(item) {
  if (!item.dueDate) return '';
  const days = Math.ceil((new Date(item.dueDate + 'T23:59:59') - Date.now()) / 86400000);
  if (days < 0) return `期日超過 ${-days}日`;
  if (days === 0) return '期日は今日';
  return `あと${days}日`;
}

// ---------------------------------------------------------------- 描画

function render() {
  renderChips();
  renderList();
}

function renderChips() {
  const box = $('#storeChips');
  const names = state.stores.length ? state.stores : collectStores();
  box.innerHTML = '';

  const mk = (label, value) => {
    const b = document.createElement('button');
    b.className = 'chip' + (state.storeFilter === value ? ' is-active' : '');
    b.textContent = label;
    b.onclick = () => { state.storeFilter = value; render(); };
    box.appendChild(b);
  };

  mk('すべて', null);
  names.forEach(n => mk(n, n));
}

function collectStores() {
  const set = new Set();
  state.items.forEach(i => (i.stores || []).forEach(s => set.add(s)));
  return [...set];
}

function visibleItems() {
  return state.items
    .filter(i => !i.deleted)
    .filter(i => state.view !== 'shopping' || i.onList)
    .filter(i => !state.storeFilter || (i.stores || []).includes(state.storeFilter))
    .sort(sortItems);
}

const URGENCY_RANK = { '必須': 0, '急ぎ': 1, '通常': 2 };

function sortItems(a, b) {
  const ua = URGENCY_RANK[a.urgency] ?? 2;
  const ub = URGENCY_RANK[b.urgency] ?? 2;
  if (ua !== ub) return ua - ub;
  if (a.dueDate !== b.dueDate) return (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
  return a.name.localeCompare(b.name, 'ja');
}

function renderList() {
  const root = $('#listView');
  root.innerHTML = '';
  const items = visibleItems();

  if (!items.length) {
    root.innerHTML = `<p class="empty">${
      state.view === 'shopping' ? '買い物リストは空です。' : '品目がありません。右下の＋から追加してください。'
    }</p>`;
    return;
  }

  if (state.view === 'shopping') {
    root.appendChild(groupTitle(`買うもの ${items.length}件${state.storeFilter ? '（' + state.storeFilter + '）' : ''}`));
    items.forEach(it => root.appendChild(shoppingCard(it)));
    return;
  }

  // カテゴリごとにまとめる。カテゴリの並びは「そのカテゴリ内で最も高い緊急度」順とし、
  // 緊急な品目を含むカテゴリが上に来るようにする（同カテゴリが分断されない）。
  const groups = new Map();
  items.forEach(it => {
    const cat = it.category || 'その他';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(it);
  });

  [...groups.entries()]
    .sort((a, b) => {
      const rank = g => Math.min(...g.map(i => URGENCY_RANK[i.urgency] ?? 2));
      const d = rank(a[1]) - rank(b[1]);
      return d !== 0 ? d : a[0].localeCompare(b[0], 'ja');
    })
    .forEach(([cat, list]) => {
      root.appendChild(groupTitle(cat));
      list.forEach(it => root.appendChild(stockCard(it)));
    });
}

function groupTitle(text) {
  const d = document.createElement('div');
  d.className = 'group-title';
  d.textContent = text;
  return d;
}

function cardShell(item) {
  const card = document.createElement('div');
  card.className = 'card' + (item.urgency === '必須' ? ' urgent' : item.urgency === '急ぎ' ? ' soon' : '');

  const main = document.createElement('div');
  main.className = 'card-main';
  main.onclick = () => openItemDialog(item);

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = item.name;
  main.appendChild(name);

  const sub = document.createElement('div');
  sub.className = 'card-sub';
  (item.stores || []).forEach(s => sub.appendChild(tag(s)));

  if (item.targetStock != null) {
    sub.appendChild(tag(`目標${fmtNum(item.targetStock)}${item.unit || ''}`, 'target'));
  }

  const due = dueLabel(item);
  if (due) sub.appendChild(tag(due, 'due'));

  const pace = paceLabel(item);
  if (pace) sub.appendChild(tag(pace, 'pace'));

  if (item.memo) sub.appendChild(tag(item.memo, 'pace'));

  main.appendChild(sub);
  card.appendChild(main);
  return card;
}

function tag(text, cls = '') {
  const s = document.createElement('span');
  s.className = 'tag ' + cls;
  s.textContent = text;
  return s;
}

/** 在庫一覧のカード: ステッパー ＋ リスト追加ボタン（1タップ） */
function stockCard(item) {
  const card = cardShell(item);

  const stepper = document.createElement('div');
  stepper.className = 'stepper';

  const minus = document.createElement('button');
  minus.textContent = '−';
  minus.onclick = () => changeStock(item, -1);

  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = fmtNum(item.stock) + (item.unit || '');

  const plus = document.createElement('button');
  plus.textContent = '＋';
  plus.onclick = () => changeStock(item, +1);

  stepper.append(minus, val, plus);
  card.appendChild(stepper);

  const btn = document.createElement('button');
  btn.className = 'act add' + (item.onList ? ' on' : '');
  btn.textContent = item.onList ? '追加済' : 'リスト';
  btn.onclick = () => toggleList(item);
  card.appendChild(btn);

  return card;
}

/** 買い物リストのカード: 購入済みボタン */
function shoppingCard(item) {
  const card = cardShell(item);

  const stock = document.createElement('span');
  stock.className = 'val';
  stock.textContent = '在庫' + fmtNum(item.stock);
  card.appendChild(stock);

  const btn = document.createElement('button');
  btn.className = 'act buy';
  btn.textContent = '購入済み';
  btn.onclick = () => openBuyDialog(item);
  card.appendChild(btn);

  return card;
}

function setStatus(text, isError = false) {
  const el = $('#statusLine');
  el.textContent = text;
  el.classList.toggle('err', isError);
}

// ---------------------------------------------------------------- ダイアログ

let editingItem = null;

function openItemDialog(item) {
  editingItem = item || null;
  const dlg = $('#itemDialog');
  // form.name はフォーム自身のname属性を指すため、必ず elements 経由で取る
  const f = $('#itemForm').elements;

  $('#itemDialogTitle').textContent = item ? '品目を編集' : '品目を追加';
  $('#btnDeleteItem').hidden = !item;

  f.name.value = item?.name || '';
  f.category.value = item?.category || '';
  f.stock.value = item ? item.stock : 0;
  f.unit.value = item?.unit || '';
  f.targetStock.value = item?.targetStock ?? '';
  f.defaultQty.value = item?.defaultQty ?? '';
  f.urgency.value = item?.urgency || '通常';
  f.dueDate.value = item?.dueDate || '';
  f.memo.value = item?.memo || '';
  f.storeExtra.value = '';

  // カテゴリ候補
  const dl = $('#categoryList');
  dl.innerHTML = '';
  [...new Set(state.items.map(i => i.category).filter(Boolean))].forEach(c => {
    const o = document.createElement('option');
    o.value = c;
    dl.appendChild(o);
  });

  // 購入先チェックボックス
  const box = $('#storeChecks');
  box.innerHTML = '';
  const known = state.stores.length ? state.stores : collectStores();
  known.forEach(s => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = s;
    cb.checked = !!item && (item.stores || []).includes(s);
    label.append(cb, document.createTextNode(s));
    box.appendChild(label);
  });

  dlg.showModal();
}

function readItemForm() {
  const f = $('#itemForm').elements;
  const checked = [...$('#storeChecks').querySelectorAll('input:checked')].map(c => c.value);
  const extra = f.storeExtra.value.split(/[,、]/).map(s => s.trim()).filter(Boolean);

  return {
    id: editingItem?.id || newId(),
    name: f.name.value.trim(),
    category: f.category.value.trim(),
    stores: [...new Set([...checked, ...extra])],
    stock: Number(f.stock.value) || 0,
    unit: f.unit.value.trim(),
    targetStock: f.targetStock.value === '' ? null : Number(f.targetStock.value),
    defaultQty: f.defaultQty.value === '' ? null : Number(f.defaultQty.value),
    urgency: f.urgency.value,
    onList: editingItem?.onList || false,
    dueDate: f.dueDate.value || '',
    memo: f.memo.value.trim(),
    deleted: false
  };
}

let buyingItem = null;

function openBuyDialog(item) {
  buyingItem = item;
  const f = $('#buyForm').elements;
  $('#buyTitle').textContent = item.name + ' を購入済みにする';
  f.qty.value = item.defaultQty ?? 1;

  const sel = f.store;
  sel.innerHTML = '';
  const opts = (item.stores && item.stores.length) ? item.stores : (state.stores.length ? state.stores : ['']);
  opts.forEach(s => {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s || '(未指定)';
    sel.appendChild(o);
  });
  if (state.storeFilter && opts.includes(state.storeFilter)) sel.value = state.storeFilter;

  const pace = estimatePace(item.id);
  $('#buyHint').textContent = pace
    ? `推定消費ペース: 1日あたり約${fmtNum(pace)}${item.unit || ''}`
    : '購入履歴が2回以上たまると消費ペースを表示します。';

  $('#buyDialog').showModal();
}

function openSettings() {
  const f = $('#settingsForm').elements;
  f.apiUrl.value = state.apiUrl;
  f.apiKey.value = state.apiKey;
  $('#settingsHint').textContent = 'GASで「デプロイ → ウェブアプリ」を作成し、末尾が /exec のURLを貼り付けてください。';
  $('#settingsDialog').showModal();
}

// ---------------------------------------------------------------- イベント配線

function bindUI() {
  $('#tabs').addEventListener('click', ev => {
    const btn = ev.target.closest('.tab');
    if (!btn) return;
    state.view = btn.dataset.view;
    [...$('#tabs').children].forEach(b => b.classList.toggle('is-active', b === btn));
    render();
  });

  $('#btnSync').onclick = () => sync();
  $('#btnSettings').onclick = () => openSettings();
  $('#btnAdd').onclick = () => openItemDialog(null);

  // ダイアログのボタンは type="button" ＋ 明示的なハンドラで処理する。
  // close イベントは非同期に発火するため、そこでフォームを読むと
  // 連続操作時に直前の入力を取りこぼす。
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.onclick = () => $('#' + btn.dataset.close).close();
  });

  // Enterキーでの暗黙送信を主ボタンの動作に寄せる
  const onEnter = (formSel, btnSel) => {
    $(formSel).addEventListener('submit', ev => { ev.preventDefault(); $(btnSel).click(); });
  };
  onEnter('#itemForm', '#btnSaveItem');
  onEnter('#buyForm', '#btnConfirmBuy');
  onEnter('#settingsForm', '#btnSaveSettings');

  $('#btnSaveItem').onclick = async () => {
    const form = $('#itemForm');
    if (!form.reportValidity()) return;
    const item = readItemForm();
    if (!item.name) return;
    $('#itemDialog').close();
    await saveItem(item);
  };

  $('#btnDeleteItem').onclick = async () => {
    if (!editingItem) return;
    if (!confirm(`「${editingItem.name}」を削除しますか？`)) return;
    const target = editingItem;
    $('#itemDialog').close();
    await saveItem({ ...target, deleted: true, onList: false });
  };

  $('#btnConfirmBuy').onclick = async () => {
    if (!buyingItem) return;
    const f = $('#buyForm').elements;
    const item = buyingItem;
    const qty = Number(f.qty.value) || 0;
    const store = f.store.value;
    buyingItem = null;
    $('#buyDialog').close();
    await markPurchased(item, qty, store);
  };

  $('#btnSaveSettings').onclick = async () => {
    const f = $('#settingsForm').elements;
    state.apiUrl = f.apiUrl.value.trim();
    state.apiKey = f.apiKey.value.trim();
    $('#settingsDialog').close();
    await DB.setMeta('apiUrl', state.apiUrl);
    await DB.setMeta('apiKey', state.apiKey);
    sync();
  };
}
