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
  syncing: false,
  ready: false,          // 起動後、最初の同期が完了したか（古いキャッシュのまま編集させないためのガード）
  clockOffsetMs: 0,       // サーバー時刻 - この端末の時計、のズレ。複数端末間の時計のズレによる
                           // Last-Write-Winsの誤判定（新しい編集が古いと誤認されて棄却される）を防ぐための補正値
  imageUrls: new Map()    // 画像ID(DriveのファイルID) -> 表示用URL。ローカルキャッシュがあれば objectURL、
                           // 無ければDriveのサムネイルURLを都度使う（imgSrcFor参照）
};

const $ = sel => document.querySelector(sel);
const nowIso = () => new Date(Date.now() + state.clockOffsetMs).toISOString();
const newId = () => 'itm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
const fmtNum = n => (Math.round(n * 10) / 10).toString();

// ---------------------------------------------------------------- 画像

const IMAGE_MAX_DIM = 240;      // サムネイルの長辺の最大px。これ以上は保存しない＝常に軽い
const IMAGE_QUALITY = 0.7;      // JPEG圧縮率

/** Driveのサムネイル配信URL（誰でもリンクを知っていれば閲覧可能な設定で保存している） */
function driveThumbUrl(fileId, size = 160) {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size}`;
}

/** 品目の写真の表示用URL。ローカルにキャッシュ済みならそれを優先し、無ければDriveから直接取得する。 */
function imgSrcFor(item) {
  if (!item.imageId) return null;
  return state.imageUrls.get(item.imageId) || driveThumbUrl(item.imageId);
}

/** 選択された画像ファイルを、長辺 IMAGE_MAX_DIM px 以内のJPEGサムネイルに縮小する。 */
function resizeImageFile(file, maxDim = IMAGE_MAX_DIM, quality = IMAGE_QUALITY) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim; }
        else { width = Math.round(width * maxDim / height); height = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('画像の変換に失敗しました')),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('画像を読み込めませんでした')); };
    img.src = objectUrl;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('画像の読み取りに失敗しました'));
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------- 起動

init();

async function init() {
  state.apiUrl = await DB.getMeta('apiUrl', '');
  state.apiKey = await DB.getMeta('apiKey', '');

  state.items = await DB.getAll('items');
  state.logs = await DB.getAll('logs');
  state.stores = await DB.getMeta('stores', []);

  // 画像はローカルにキャッシュしたBlobから objectURL を作っておく。
  // 描画（render）は同期処理なので、表示のたびにIndexedDBへ問い合わせずに済むよう起動時にまとめて読む。
  const images = await DB.getAll('images');
  images.forEach(row => state.imageUrls.set(row.id, URL.createObjectURL(row.blob)));

  // 保存処理などは非同期なので、握り潰さずステータス行に出す
  window.addEventListener('unhandledrejection', ev => {
    setStatus('エラー: ' + (ev.reason?.message || ev.reason), true);
  });

  bindUI();
  render();

  if (!state.apiUrl) {
    setStatus('GASのURLが未設定です。右上の⚙から設定してください。', true);
    openSettings();
    state.ready = true;
  } else {
    // 起動直後の同期が終わるまで待ってから編集を許可する。
    // 待たずに編集できてしまうと、まだ他の端末の最新の変更を取得していない
    // 古いキャッシュを元に保存してしまい、その変更を巻き戻すことがある。
    await sync();
    state.ready = true;
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

    // サーバーが「他の端末による、より新しい更新がある」と判断してこちらの変更を
    // 棄却した場合、何も表示しないと編集内容が静かに消えたように見えてしまう。
    // 該当した品目名を拾ってステータス行で知らせる（値自体はサーバー側の最新のものに揃う）。
    const rejectedIds = (res.items?.applied || [])
      .filter(a => a.result === 'rejected-stale')
      .map(a => a.id);
    if (rejectedIds.length) {
      const names = rejectedIds.map(id => state.items.find(i => i.id === id)?.name || id);
      setStatus(`他の端末での更新が新しいため反映されませんでした: ${names.join('、')}`, true);
    } else {
      setStatus('最終同期 ' + new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
    }
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
  // この端末の時計とサーバー時刻のズレを都度更新しておく。
  // 次にこの端末で保存するときの updatedAt はこのズレを補正した値になるため、
  // 端末間で時計がずれていても、本当に後から行った編集が正しく「新しい」と判定されるようになる。
  if (data.serverTime) {
    state.clockOffsetMs = new Date(data.serverTime).getTime() - Date.now();
  }

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

/**
 * 全品目に対して applyAutoListRules を再適用し、買い物リストの出し入れをまとめて反映する。
 * スプレッドシート側で目標在庫数だけ後から入力した場合など、
 * 個別の在庫増減や保存を経由しない変更を拾うための手動トリガー。
 */
async function runAutoListCheck() {
  if (!requireReady()) return;
  const targets = state.items.filter(i => !i.deleted);
  let changed = 0;

  for (const item of targets) {
    const next = applyAutoListRules(item);
    if (next.onList !== item.onList || next.urgency !== item.urgency) {
      changed++;
      await saveItem(next, { immediateSync: false });
    }
  }

  render();
  updateBadge();
  setStatus(changed ? `目標在庫チェック: ${changed}件をリストに反映しました` : '目標在庫チェック: 変更はありませんでした');
  if (changed) sync();
}

async function addLog(log) {
  log.key = logKey(log.itemId, log.at);
  state.logs.push(log);
  await DB.put('logs', log);
  await DB.enqueue('log', log);
}

/**
 * 買い物リストへの自動追加ルール。すべての更新経路（保存・在庫増減・購入・手動チェック）で共通して使う。
 *
 * - 在庫が目標在庫数の2倍以上ある品目は、緊急度を自動で「不要」にしてリストから外す（過剰在庫）。
 * - 「不要」（上記の自動判定、または手動設定）の品目は対象外にし、強制的にリストから外す。
 * - 在庫が0の品目は、緊急度を「必須」にして自動でリスト入りさせる。
 * - 在庫が目標在庫数以下の品目は、自動でリスト入りさせる（緊急度はそのまま）。
 * - どれにも該当しない場合は、呼び出し元が設定した onList / urgency をそのまま尊重する。
 */
function applyAutoListRules(item) {
  if (item.targetStock != null && item.targetStock > 0 && item.stock >= item.targetStock * 2) {
    return { ...item, urgency: '不要', onList: false };
  }

  if (item.urgency === '不要') return { ...item, onList: false };

  if (item.stock <= 0) {
    return { ...item, onList: true, urgency: '必須' };
  }
  if (item.targetStock != null && item.stock <= item.targetStock) {
    return { ...item, onList: true };
  }
  return item;
}

/** 在庫を増減。0になったら自動で「必須」＋買い物リスト入り。目標在庫数以下になった場合も自動でリスト入り。 */
async function changeStock(item, delta) {
  if (!requireReady()) return;
  const next = applyAutoListRules({ ...item, stock: Math.max(0, item.stock + delta) });
  await saveItem(next);
}

async function toggleList(item) {
  if (!requireReady()) return;
  const next = { ...item, onList: !item.onList };
  if (!next.onList && next.urgency === '必須' && next.stock > 0) next.urgency = '通常';
  await saveItem(next);
}

/** 買い物リストでの「購入予定数」を増減する。未設定なら defaultPlanQty() を初期値とする。 */
async function changePlanQty(item, delta) {
  if (!requireReady()) return;
  const current = item.planQty ?? defaultPlanQty(item);
  const next = { ...item, planQty: Math.max(0, current + delta) };
  await saveItem(next);
}

/** 購入済み: リストから外し、在庫を加算し、履歴を記録。購入予定数は次回のために未設定へ戻す。 */
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
  const next = applyAutoListRules({ ...item, stock: stockAfter, onList: false, urgency: '通常', dueDate: '', planQty: null });
  await saveItem(next);
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

/**
 * 購入予定数の初期値を計算する。
 * 購入単位数（デフォルト）が1、または未設定の場合は「1個ずつ買い足す」品目とみなし、
 * 目標在庫数との不足数を初期値にする（目標未設定なら1）。
 * 購入単位数が1以外（トイレットペーパー18ロール等、まとめ買いのロット数）の場合は、
 * その数量をそのまま初期値として使う。
 */
function defaultPlanQty(item) {
  if (item.defaultQty != null && item.defaultQty !== 1) return item.defaultQty;
  if (item.targetStock != null) {
    const need = item.targetStock - item.stock;
    return need > 0 ? need : 1;
  }
  return item.defaultQty ?? 1;
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

const URGENCY_RANK = { '必須': 0, '急ぎ': 1, '通常': 2, '不要': 3 };

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

/**
 * カードは上下2段構成にする。
 * 上段（.card-top）: サムネイル＋品名・タグ。ここは折り返しても構わないので幅を優先する。
 * 下段（.card-bottom）: ステッパーや操作ボタン。stockCard/shoppingCard が中身を追加する。
 * サムネイルとボタン類を横1列に並べると、特に長い品名やステッパーの大型化と重なって
 * 品名の表示幅が極端に狭くなってしまうため、2段に分けている。
 */
function cardShell(item) {
  const card = document.createElement('div');
  card.className = 'card' + (
    item.urgency === '必須' ? ' urgent' :
    item.urgency === '急ぎ' ? ' soon' :
    item.urgency === '不要' ? ' skip' : ''
  );

  const top = document.createElement('div');
  top.className = 'card-top';

  const thumbSrc = imgSrcFor(item);
  if (thumbSrc) {
    const thumb = document.createElement('img');
    thumb.className = 'card-thumb';
    thumb.src = thumbSrc;
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.decoding = 'async';
    // Driveの共有設定変更やオフライン等で読み込めない場合は、崩れた画像アイコンのままにせず控えめなプレースホルダーに差し替える
    thumb.onerror = () => {
      const ph = document.createElement('span');
      ph.className = 'card-thumb card-thumb-placeholder';
      ph.textContent = '📦';
      thumb.replaceWith(ph);
    };
    thumb.onclick = () => openItemDialog(item);
    top.appendChild(thumb);
  }

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
    const need = item.targetStock - item.stock;
    const label = need > 0
      ? `目標${fmtNum(item.targetStock)}${item.unit || ''}（あと${fmtNum(need)}補充）`
      : `目標${fmtNum(item.targetStock)}${item.unit || ''}`;
    sub.appendChild(tag(label, 'target'));
  }

  const due = dueLabel(item);
  if (due) sub.appendChild(tag(due, 'due'));

  const pace = paceLabel(item);
  if (pace) sub.appendChild(tag(pace, 'pace'));

  if (item.memo) sub.appendChild(tag(item.memo, 'pace'));

  main.appendChild(sub);
  top.appendChild(main);
  card.appendChild(top);

  const bottom = document.createElement('div');
  bottom.className = 'card-bottom';
  card.appendChild(bottom);

  return card;
}

function tag(text, cls = '') {
  const s = document.createElement('span');
  s.className = 'tag ' + cls;
  s.textContent = text;
  return s;
}

/** 買い物リストの「在庫 / 目標」のような、ラベル＋値の縦積み表示を作る */
function statBlock(label, value) {
  const box = document.createElement('div');
  box.className = 'stat';
  const l = document.createElement('span');
  l.className = 'stat-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'stat-value';
  v.textContent = value;
  box.append(l, v);
  return box;
}

/** 在庫一覧のカード: ステッパー ＋ リスト追加ボタン（1タップ） */
function stockCard(item) {
  const card = cardShell(item);
  const bottom = card.querySelector('.card-bottom');

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
  bottom.appendChild(stepper);

  const btn = document.createElement('button');
  btn.className = 'act add' + (item.onList ? ' on' : '');
  btn.textContent = item.onList ? '追加済' : 'リスト';
  btn.onclick = () => toggleList(item);
  bottom.appendChild(btn);

  return card;
}

/** 買い物リストのカード: 購入済みボタン */
function shoppingCard(item) {
  const card = cardShell(item);
  const bottom = card.querySelector('.card-bottom');

  const stats = document.createElement('div');
  stats.className = 'shop-stats';
  stats.appendChild(statBlock('在庫', fmtNum(item.stock) + (item.unit || '')));
  if (item.targetStock != null) {
    stats.appendChild(statBlock('目標', fmtNum(item.targetStock) + (item.unit || '')));
  }

  const planStat = document.createElement('div');
  planStat.className = 'stat';
  const planLabel = document.createElement('span');
  planLabel.className = 'stat-label';
  planLabel.textContent = '予定';
  const planStepper = document.createElement('div');
  planStepper.className = 'stepper sm';
  const planQty = item.planQty ?? defaultPlanQty(item);

  const minus = document.createElement('button');
  minus.textContent = '−';
  minus.onclick = () => changePlanQty(item, -1);

  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = fmtNum(planQty) + (item.unit || '');

  const plus = document.createElement('button');
  plus.textContent = '＋';
  plus.onclick = () => changePlanQty(item, +1);

  planStepper.append(minus, val, plus);
  planStat.append(planLabel, planStepper);
  stats.appendChild(planStat);

  bottom.appendChild(stats);

  const btn = document.createElement('button');
  btn.className = 'act buy';
  btn.textContent = '購入済み';
  btn.onclick = () => openBuyDialog(item);
  bottom.appendChild(btn);

  return card;
}

function setStatus(text, isError = false) {
  const el = $('#statusLine');
  el.textContent = text;
  el.classList.toggle('err', isError);
}

/**
 * 起動直後の同期が終わる前に編集操作をさせない。
 * ここでブロックしないと、他の端末での最新の変更をまだ取得していない
 * 古いキャッシュを元に保存してしまい、その変更を巻き戻してしまうことがある。
 */
function requireReady() {
  if (state.ready) return true;
  setStatus('起動直後の同期が完了するまでお待ちください…', true);
  return false;
}

// ---------------------------------------------------------------- ダイアログ

let editingItem = null;
// 写真は選択直後にすぐ確定させず、保存ボタンを押したタイミングでアップロードする。
// pendingPhotoBlob: 新しく選んだ（まだアップロードしていない）縮小済み画像
// removePhotoRequested: 「×」で既存の写真を消すことを選んだか
let pendingPhotoBlob = null;
let removePhotoRequested = false;

function openItemDialog(item) {
  if (!requireReady()) return;
  editingItem = item || null;
  pendingPhotoBlob = null;
  removePhotoRequested = false;
  const dlg = $('#itemDialog');
  // form.name はフォーム自身のname属性を指すため、必ず elements 経由で取る
  const f = $('#itemForm').elements;

  $('#itemDialogTitle').textContent = item ? '品目を編集' : '品目を追加';
  $('#btnDeleteItem').hidden = !item;
  showPhotoPreview(item ? imgSrcFor(item) : null);

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
    deleted: false,
    imageId: editingItem?.imageId ?? null // 写真自体の変更は保存ボタンのハンドラで別途反映する
  };
}

let buyingItem = null;

function openBuyDialog(item) {
  if (!requireReady()) return;
  buyingItem = item;
  const f = $('#buyForm').elements;
  $('#buyTitle').textContent = item.name + ' を購入済みにする';
  // 買い物リストで設定した「購入予定数」があればそれを優先し、無ければ defaultPlanQty() を使う
  f.qty.value = item.planQty ?? defaultPlanQty(item);

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

/** 品目編集ダイアログの写真プレビュー表示を切り替える。url が null なら未設定表示に戻す。 */
function showPhotoPreview(url) {
  const img = $('#itemPhotoPreview');
  const placeholder = $('#itemPhotoPlaceholder');
  const removeBtn = $('#btnRemovePhoto');
  if (url) {
    img.src = url;
    img.hidden = false;
    placeholder.hidden = true;
    removeBtn.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    placeholder.hidden = false;
    removeBtn.hidden = true;
  }
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
  $('#btnAutoCheck').onclick = () => runAutoListCheck();
  $('#btnSettings').onclick = () => openSettings();
  $('#btnAdd').onclick = () => openItemDialog(null);

  $('#photoBox').onclick = () => $('#itemPhotoInput').click();
  $('#photoBox').onkeydown = ev => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); $('#itemPhotoInput').click(); }
  };

  $('#itemPhotoInput').addEventListener('change', async ev => {
    const file = ev.target.files[0];
    ev.target.value = ''; // 同じファイルを選び直せるようにする
    if (!file) return;
    try {
      setStatus('写真を処理中…');
      const blob = await resizeImageFile(file);
      pendingPhotoBlob = blob;
      removePhotoRequested = false;
      showPhotoPreview(URL.createObjectURL(blob));
      setStatus('');
    } catch (e) {
      setStatus('写真の処理に失敗しました: ' + e.message, true);
    }
  });

  $('#btnRemovePhoto').onclick = ev => {
    ev.stopPropagation();
    pendingPhotoBlob = null;
    removePhotoRequested = true;
    showPhotoPreview(null);
  };

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

  // スマホのタップは稀に同じボタンで複数のクリックイベントを起こすことがある（連打・タップの誤検知）。
  // 保存系のボタンが多重に発火すると、2回目以降が閉じかけのダイアログや空のフォームを読んでしまい、
  // 正しく入力した値を直後に空で上書きしてしまう恐れがあるため、処理中は無視するようにする。
  const guardClick = (btnSel, fn) => {
    const btn = $(btnSel);
    let busy = false;
    btn.onclick = async () => {
      if (busy) return;
      busy = true;
      try { await fn(); } finally { busy = false; }
    };
  };

  guardClick('#btnSaveItem', async () => {
    const form = $('#itemForm');
    if (!form.reportValidity()) return;
    const item = applyAutoListRules(readItemForm());
    if (!item.name) return;

    if (removePhotoRequested) {
      item.imageId = null;
    } else if (pendingPhotoBlob) {
      // 写真のアップロードはネットワーク通信を伴うため、ここで待つ。
      // 失敗した場合は品目自体の保存も中断し、「保存はされたが写真だけ消えた」状態を避ける。
      if (!navigator.onLine) {
        setStatus('オフライン中は写真を追加できません。オンライン復帰後にもう一度お試しください。', true);
        return;
      }
      try {
        setStatus('写真をアップロード中…');
        const dataUrl = await blobToDataUrl(pendingPhotoBlob);
        const oldFileId = editingItem?.imageId || null;
        const res = await post('uploadImage', { itemId: item.id, dataUrl, oldFileId });
        item.imageId = res.fileId;
        state.imageUrls.set(res.fileId, URL.createObjectURL(pendingPhotoBlob));
        await DB.put('images', { id: res.fileId, blob: pendingPhotoBlob });
      } catch (e) {
        setStatus('写真のアップロードに失敗しました: ' + e.message, true);
        return;
      }
    }

    $('#itemDialog').close();
    await saveItem(item);
    pendingPhotoBlob = null;
    removePhotoRequested = false;
  });

  guardClick('#btnDeleteItem', async () => {
    if (!editingItem) return;
    if (!confirm(`「${editingItem.name}」を削除しますか？`)) return;
    const target = editingItem;
    $('#itemDialog').close();
    await saveItem({ ...target, deleted: true, onList: false });
  });

  guardClick('#btnConfirmBuy', async () => {
    if (!buyingItem) return;
    const f = $('#buyForm').elements;
    const item = buyingItem;
    const qty = Number(f.qty.value) || 0;
    const store = f.store.value;
    buyingItem = null;
    $('#buyDialog').close();
    await markPurchased(item, qty, store);
  });

  guardClick('#btnSaveSettings', async () => {
    const f = $('#settingsForm').elements;
    state.apiUrl = f.apiUrl.value.trim();
    state.apiKey = f.apiKey.value.trim();
    $('#settingsDialog').close();
    await DB.setMeta('apiUrl', state.apiUrl);
    await DB.setMeta('apiKey', state.apiKey);
    sync();
  });
}
