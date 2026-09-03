/**
 * 在庫管理・買い物リスト PWA — バックエンドAPI
 *
 * 使い方:
 *  1. スプレッドシートの「拡張機能 → Apps Script」にこのファイルを全文貼り付け
 *  2. setupSheets() を一度実行してシートを初期化
 *  3. デプロイ → 新しいデプロイ → ウェブアプリ
 *     （実行ユーザー: 自分 / アクセス: 全員）
 *
 * API_KEY を空文字以外にすると、リクエストに同じ key が必要になります。
 */
var API_KEY = '';

var SHEET_ITEMS = '品目マスタ';
var SHEET_LOG = '購入履歴';
var SHEET_STORES = '購入先マスタ';

var ITEM_HEADERS = [
  'id', '品名', 'カテゴリ', '購入先', '在庫数', '単位', '目標在庫数', '購入単位数',
  '緊急度', '買い物リスト', '購入期日', 'メモ', '更新日時', '削除'
];
var LOG_HEADERS = ['日時', '品目ID', '品名', '購入数', '購入先', '購入後在庫'];
var STORE_HEADERS = ['店名', '表示順'];

// ---------------------------------------------------------------- エントリポイント

function doGet(e) {
  try {
    checkKey(e && e.parameter);
    return json({ ok: true, data: readAll() });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

/**
 * フロントからは Content-Type: text/plain で送る（CORSプリフライト回避のため）。
 * body: { key, action, payload }
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var req = JSON.parse(e.postData.contents);
    checkKey(req);

    lock.waitLock(25000);

    var result;
    switch (req.action) {
      case 'upsertItems':   result = upsertItems(req.payload || []); break;
      case 'appendLogs':    result = appendLogs(req.payload || []); break;
      case 'sync':          result = syncBatch(req.payload || {}); break;
      default: throw new Error('unknown action: ' + req.action);
    }
    return json({ ok: true, data: result });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function checkKey(obj) {
  if (!API_KEY) return;
  if (!obj || obj.key !== API_KEY) throw new Error('unauthorized');
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- 読み取り

function readAll() {
  return {
    items: readItems(),
    logs: readLogs(),
    stores: readStores(),
    serverTime: new Date().toISOString()
  };
}

function readItems() {
  var rows = getRows(SHEET_ITEMS, ITEM_HEADERS);
  return rows.map(function (r) {
    return {
      id: String(r['id'] || ''),
      name: String(r['品名'] || ''),
      category: String(r['カテゴリ'] || ''),
      stores: splitStores(r['購入先']),
      stock: numOrZero(r['在庫数']),
      unit: String(r['単位'] || ''),
      targetStock: emptyToNull(r['目標在庫数']),
      defaultQty: emptyToNull(r['購入単位数']),
      urgency: String(r['緊急度'] || '通常'),
      onList: toBool(r['買い物リスト']),
      dueDate: toDateStr(r['購入期日']),
      memo: String(r['メモ'] || ''),
      updatedAt: toIso(r['更新日時']),
      deleted: toBool(r['削除'])
    };
  }).filter(function (it) { return it.id && it.name; });
}

function readLogs() {
  var rows = getRows(SHEET_LOG, LOG_HEADERS);
  return rows.map(function (r) {
    return {
      at: toIso(r['日時']),
      itemId: String(r['品目ID'] || ''),
      name: String(r['品名'] || ''),
      qty: numOrZero(r['購入数']),
      store: String(r['購入先'] || ''),
      stockAfter: numOrZero(r['購入後在庫'])
    };
  }).filter(function (l) { return l.itemId && l.at; });
}

function readStores() {
  var rows = getRows(SHEET_STORES, STORE_HEADERS);
  return rows
    .filter(function (r) { return String(r['店名'] || '').trim(); })
    .map(function (r) {
      return { name: String(r['店名']).trim(), order: numOrZero(r['表示順']) };
    })
    .sort(function (a, b) { return a.order - b.order; });
}

/** ヘッダ行を見出しとして各行をオブジェクト化。列順が変わっても壊れないようにする。 */
function getRows(sheetName, expectedHeaders) {
  var sh = ss().getSheetByName(sheetName);
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  var header = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.join('') === '') continue;
    var obj = {};
    for (var c = 0; c < header.length; c++) {
      if (header[c]) obj[header[c]] = row[c];
    }
    out.push(obj);
  }
  return out;
}

// ---------------------------------------------------------------- 書き込み

/**
 * Last-Write-Wins で品目を更新。
 * シート側の更新日時が受信データより新しければ書き込まない。
 * 戻り値には「勝った側の最新レコード」を返し、クライアントがそれで上書きできるようにする。
 */
function upsertItems(items) {
  var sh = ensureSheet(SHEET_ITEMS, ITEM_HEADERS);
  var values = sh.getDataRange().getValues();
  var header = values[0].map(function (h) { return String(h).trim(); });
  var colOf = {};
  header.forEach(function (h, i) { if (h) colOf[h] = i; });

  var rowOfId = {};
  for (var i = 1; i < values.length; i++) {
    var id = String(values[i][colOf['id']] || '');
    if (id) rowOfId[id] = i;
  }

  var applied = [];
  items.forEach(function (it) {
    if (!it || !it.id) return;
    var rowIdx = rowOfId[it.id];

    if (rowIdx === undefined) {
      sh.appendRow(itemToRow(it, header));
      applied.push({ id: it.id, result: 'inserted' });
      return;
    }

    var serverUpdated = toIso(values[rowIdx][colOf['更新日時']]);
    // 更新日時が空（＝シート直編集の可能性）またはクライアントが新しければ書き込む
    if (serverUpdated && it.updatedAt && serverUpdated > it.updatedAt) {
      applied.push({ id: it.id, result: 'rejected-stale' });
      return;
    }
    var row = itemToRow(it, header);
    sh.getRange(rowIdx + 1, 1, 1, header.length).setValues([row]);
    applied.push({ id: it.id, result: 'updated' });
  });

  return { applied: applied };
}

function itemToRow(it, header) {
  var map = {
    'id': it.id,
    '品名': it.name || '',
    'カテゴリ': it.category || '',
    '購入先': (it.stores || []).join(','),
    '在庫数': numOrZero(it.stock),
    '単位': it.unit || '',
    '目標在庫数': (it.targetStock === null || it.targetStock === undefined || it.targetStock === '') ? '' : Number(it.targetStock),
    '購入単位数': (it.defaultQty === null || it.defaultQty === undefined || it.defaultQty === '') ? '' : Number(it.defaultQty),
    '緊急度': it.urgency || '通常',
    '買い物リスト': it.onList ? true : false,
    '購入期日': it.dueDate || '',
    'メモ': it.memo || '',
    '更新日時': it.updatedAt || new Date().toISOString(),
    '削除': it.deleted ? true : false
  };
  return header.map(function (h) { return map.hasOwnProperty(h) ? map[h] : ''; });
}

/** 購入履歴は追記専用。同一(itemId, at)は重複送信とみなしてスキップ。 */
function appendLogs(logs) {
  if (!logs.length) return { appended: 0 };
  var sh = ensureSheet(SHEET_LOG, LOG_HEADERS);
  var existing = {};
  readLogs().forEach(function (l) { existing[l.itemId + '|' + l.at] = true; });

  var rows = [];
  logs.forEach(function (l) {
    if (!l || !l.itemId || !l.at) return;
    if (existing[l.itemId + '|' + l.at]) return;
    rows.push([l.at, l.itemId, l.name || '', numOrZero(l.qty), l.store || '', numOrZero(l.stockAfter)]);
  });
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, LOG_HEADERS.length).setValues(rows);
  }
  return { appended: rows.length };
}

/** 品目更新・履歴追記・最新データ取得を1往復で済ませる。オフライン復帰時の同期で使う。 */
function syncBatch(payload) {
  var res = {};
  if (payload.items && payload.items.length) res.items = upsertItems(payload.items);
  if (payload.logs && payload.logs.length) res.logs = appendLogs(payload.logs);
  res.data = readAll();
  return res;
}

// ---------------------------------------------------------------- 初期化

function setupSheets() {
  var book = ss();
  ensureSheet(SHEET_ITEMS, ITEM_HEADERS);
  ensureSheet(SHEET_LOG, LOG_HEADERS);
  var stores = ensureSheet(SHEET_STORES, STORE_HEADERS);

  // 既存シートにコードが期待する列が無い場合、末尾に追加する（データは保持したまま）。
  // main.gs を更新した後にもう一度 setupSheets を実行すれば、この移行が自動で走る。
  ensureColumns(SHEET_ITEMS, ITEM_HEADERS);

  if (stores.getLastRow() < 2) {
    stores.getRange(2, 1, 4, 2).setValues([
      ['コストコ', 1],
      ['業務スーパー', 2],
      ['ダイソー', 3],
      ['スーパー', 4]
    ]);
  }

  var items = book.getSheetByName(SHEET_ITEMS);
  if (items.getLastRow() < 2) {
    var now = new Date().toISOString();
    items.getRange(2, 1, 3, ITEM_HEADERS.length).setValues([
      [newId(), '牛乳', '食材', 'コストコ,業務スーパー', 3, 'パック', 4, 2, '通常', false, '', '', now, false],
      [newId(), 'トイレットペーパー', '日用品', 'コストコ', 0, 'パック', 12, 18, '必須', true, '', '', now, false],
      [newId(), 'セロテープ', '日用品', 'ダイソー', 1, '個', '', '', '通常', false, '2026-09-30', '急ぎではない', now, false]
    ]);
  }

  // 入力補助: 緊急度のプルダウン
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['通常', '急ぎ', '必須'], true).build();
  items.getRange(2, ITEM_HEADERS.indexOf('緊急度') + 1, 1000, 1).setDataValidation(rule);

  items.setFrozenRows(1);
  SpreadsheetApp.flush();
}

function ensureSheet(name, headers) {
  var book = ss();
  var sh = book.getSheetByName(name);
  if (!sh) sh = book.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 既存シートのヘッダ行に無い列を末尾に追加する。データ列の並びには依存しないコードなので、追加位置は末尾で問題ない。 */
function ensureColumns(sheetName, headers) {
  var sh = ss().getSheetByName(sheetName);
  if (!sh || sh.getLastRow() === 0) return [];
  var lastCol = sh.getLastColumn();
  var current = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var missing = headers.filter(function (h) { return current.indexOf(h) === -1; });
  if (missing.length) {
    sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  return missing;
}

/**
 * シート上で行を直接追加したとき用のメニュー。
 * id や更新日時が空の行を自動で埋める。
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('在庫管理')
    .addItem('空のID/更新日時を埋める', 'fillMissingIds')
    .addItem('シート初期化', 'setupSheets')
    .addToUi();
}

function fillMissingIds() {
  var sh = ss().getSheetByName(SHEET_ITEMS);
  var values = sh.getDataRange().getValues();
  var header = values[0].map(function (h) { return String(h).trim(); });
  var idCol = header.indexOf('id');
  var upCol = header.indexOf('更新日時');
  var nameCol = header.indexOf('品名');
  var now = new Date().toISOString();
  var changed = 0;

  for (var i = 1; i < values.length; i++) {
    if (!String(values[i][nameCol] || '').trim()) continue;
    if (!String(values[i][idCol] || '').trim()) {
      sh.getRange(i + 1, idCol + 1).setValue(newId());
      changed++;
    }
    if (!String(values[i][upCol] || '').trim()) {
      sh.getRange(i + 1, upCol + 1).setValue(now);
      changed++;
    }
  }
  SpreadsheetApp.getActive().toast(changed + ' セルを補完しました');
}

// ---------------------------------------------------------------- ユーティリティ

function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }

function newId() {
  return 'itm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
}

function splitStores(v) {
  return String(v || '').split(/[,、]/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s; });
}

function numOrZero(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

/** 空セルは null（未設定）として扱う。0とは区別する。 */
function emptyToNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

function toBool(v) {
  if (v === true) return true;
  var s = String(v).trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === 'YES' || s === '○';
}

function toIso(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  return String(v).trim();
}

/** 購入期日は yyyy-MM-dd の文字列で扱う */
function toDateStr(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v).trim();
}
