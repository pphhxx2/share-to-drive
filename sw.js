/* 傳檔 — Service Worker
 * 1) 攔截分享目標 POST ./share-target，把檔案存進 IndexedDB，再 303 轉址到 ./?shared=1
 * 2) 快取 App 外殼，讓離線也能開啟
 */
'use strict';

var CACHE = 'share-to-drive-v3';
var SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
var DB_NAME = 'share-to-drive';
var DB_STORE = 'queue';

function openDB() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function idbPutAll(items) {
  return openDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, 'readwrite');
      var st = tx.objectStore(DB_STORE);
      items.forEach(function (it) { st.put(it); });
      tx.oncomplete = function () { db.close(); resolve(items.length); };
      tx.onerror = function () { db.close(); reject(tx.error); };
    });
  });
}

function pad(n) { return (n < 10 ? '0' : '') + n; }
function stamp(d) {
  d = d || new Date();
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}
var seq = 0;
function newId() { return Date.now().toString(36) + '-' + (seq++).toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

/** 把分享進來的 FormData 轉成佇列項目（純邏輯，可單元測試）。 */
function itemsFromFormData(fd, now) {
  now = now || new Date();
  var items = [];
  // 先取 'files' 欄位；若沒有，掃描所有欄位中的檔案（不同 App 傳法不一）
  var files = (fd.getAll('files') || []).filter(function (f) { return f && typeof f !== 'string'; });
  if (!files.length && typeof fd.forEach === 'function') fd.forEach(function (v) { if (v && typeof v !== 'string') files.push(v); });
  files.forEach(function (f, i) {
    if (!f || typeof f === 'string') return;
    if (!f.size && !f.name) return;
    items.push({
      id: newId(), source: 'share', createdAt: now.getTime(),
      name: f.name || ('分享檔案-' + stamp(now) + '-' + (i + 1)),
      type: f.type || 'application/octet-stream',
      size: f.size, blob: f, status: 'pending'
    });
  });
  var title = String(fd.get('title') || '').trim();
  var text = String(fd.get('text') || '').trim();
  var url = String(fd.get('url') || '').trim();
  // 有文字或網址就存成 .txt；只有標題時，只在沒有檔案的情況下存
  if (text || url || (title && items.length === 0)) {
    var lines = [];
    if (title) lines.push(title);
    if (text) lines.push(text);
    if (url && text.indexOf(url) === -1) lines.push(url);
    var body = lines.join('\n\n') + '\n';
    var blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    items.push({
      id: newId(), source: 'share', createdAt: now.getTime(),
      name: '分享文字-' + stamp(now) + '.txt', type: 'text/plain',
      size: blob.size, blob: blob, status: 'pending'
    });
  }
  return items;
}

function handleShare(request, store) {
  store = store || idbPutAll;
  return request.formData().then(function (fd) {
    var items = itemsFromFormData(fd);
    return store(items).then(function () {
      if (self.clients && self.clients.matchAll) self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) { cs.forEach(function (c) { c.postMessage({ type: 'shared', n: items.length }); }); });
      return items.length;
    });
  }).then(function (n) {
    return Response.redirect('./?shared=1&n=' + n, 303);
  }).catch(function (err) {
    return Response.redirect('./?shared=1&error=' + encodeURIComponent(String(err && err.message || err)), 303);
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (req.method === 'POST' && url.origin === self.location.origin && /\/share-target\/?$/.test(url.pathname)) {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // 網路優先，失敗才用快取（確保更新後能拿到新版）
  event.respondWith(fetch(req).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || caches.match('./index.html'); });
  }));
});

if (typeof module !== 'undefined') module.exports = { itemsFromFormData: itemsFromFormData, handleShare: handleShare, stamp: stamp };
