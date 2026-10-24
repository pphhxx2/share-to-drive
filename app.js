/* 傳檔 — 前端邏輯 */
'use strict';
(function () {
  var DB_NAME = 'share-to-drive', DB_STORE = 'queue';
  var MAX_BYTES = 35 * 1024 * 1024; // Apps Script 單次請求約 50MB，base64 會膨脹約 1.33 倍
  var LS = { url: 'std.url', key: 'std.key', compress: 'std.compress', folder: 'std.folderUrl' };
  var $ = function (id) { return document.getElementById(id); };
  var busy = false;

  // ---------- IndexedDB ----------
  function openDB() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains(DB_STORE)) r.result.createObjectStore(DB_STORE, { keyPath: 'id' }); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function tx(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(DB_STORE, mode), st = t.objectStore(DB_STORE), out;
        out = fn(st);
        t.oncomplete = function () { db.close(); resolve(out && 'result' in out ? out.result : out); };
        t.onerror = function () { db.close(); reject(t.error); };
      });
    });
  }
  var dbAll = function () { return tx('readonly', function (st) { return st.getAll(); }).then(function (a) { return (a || []).sort(function (x, y) { return x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1); }); }); };
  var dbPut = function (it) { return tx('readwrite', function (st) { st.put(it); }); };
  var dbDel = function (id) { return tx('readwrite', function (st) { st.delete(id); }); };

  // ---------- 設定 ----------
  function cfg() { return { url: (localStorage.getItem(LS.url) || '').trim(), key: (localStorage.getItem(LS.key) || '').trim(), compress: localStorage.getItem(LS.compress) === '1' }; }
  function showSettings(show) {
    $('settings').classList.toggle('hidden', !show);
    if (show) { var c = cfg(); $('inUrl').value = c.url; $('inKey').value = c.key; $('inCompress').checked = c.compress; $('settingsMsg').textContent = ''; }
  }
  function setMsg(el, text, ok) { el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); }
  function validUrl(u) { return /^https:\/\/script\.google(usercontent)?\.com\/.+/.test(u); }

  // ---------- 送出到 Apps Script ----------
  function post(url, payload, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8'); // 簡單請求，不觸發 CORS 預檢
      xhr.timeout = 6 * 60 * 1000;
      if (onProgress && xhr.upload) xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = function () {
        var res; try { res = JSON.parse(xhr.responseText); } catch (e) { return reject(new Error('伺服器回應無法解析（HTTP ' + xhr.status + '），請確認網址與部署權限設為「所有人」')); }
        if (res && res.ok) resolve(res); else reject(new Error((res && res.error) || '上傳失敗'));
      };
      xhr.onerror = function () { reject(new Error('網路錯誤，或網址／部署權限不正確')); };
      xhr.ontimeout = function () { reject(new Error('連線逾時')); };
      xhr.send(JSON.stringify(payload));
    });
  }
  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = function () { reject(fr.error || new Error('讀取檔案失敗')); };
      fr.readAsDataURL(blob);
    });
  }
  function maybeCompress(item) {
    if (!cfg().compress || !/^image\/(jpeg|png|webp)$/.test(item.type) || typeof createImageBitmap !== 'function') return Promise.resolve(item);
    return createImageBitmap(item.blob).then(function (bmp) {
      var max = 2560, s = Math.min(1, max / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (r) { c.toBlob(r, 'image/jpeg', 0.85); });
    }).then(function (b) {
      if (!b || b.size >= item.blob.size) return item;
      return { blob: b, type: 'image/jpeg', name: item.name.replace(/\.(png|webp|jpe?g)$/i, '') + '.jpg' };
    }).catch(function () { return item; });
  }

  // ---------- 畫面 ----------
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function rowFor(it) {
    var li = document.getElementById('row-' + it.id);
    if (!li) {
      li = document.createElement('li'); li.id = 'row-' + it.id;
      li.innerHTML = '<div class="fname"><span class="n"></span><span class="fstat"></span></div><div class="fsub"></div><progress max="1" value="0"></progress>';
      $('list').appendChild(li);
    }
    li.querySelector('.n').textContent = it.name;
    return li;
  }
  function paint(it, prog) {
    var li = rowFor(it), st = li.querySelector('.fstat'), sub = li.querySelector('.fsub'), pg = li.querySelector('progress');
    var map = { pending: '⏳ 等待中', uploading: '⬆️ ' + Math.round((prog || 0) * 100) + '%', done: '✅', error: '❌' };
    st.textContent = map[it.status] || '';
    st.style.color = it.status === 'error' ? 'var(--err)' : it.status === 'done' ? 'var(--ok)' : '';
    sub.textContent = fmtSize(it.size || 0) + (it.status === 'error' && it.error ? '｜' + it.error : '');
    if (it.status === 'done' && it.url) { sub.innerHTML = ''; sub.append(fmtSize(it.size || 0) + '｜'); var a = document.createElement('a'); a.href = it.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '開啟檔案'; sub.appendChild(a); }
    pg.value = it.status === 'done' ? 1 : it.status === 'uploading' ? (prog || 0) : 0;
    pg.classList.toggle('hidden', it.status === 'done' || it.status === 'error');
    $('progressCard').classList.remove('hidden');
  }
  var doneThisRun = 0;
  function summarize(items) {
    var err = items.filter(function (i) { return i.status === 'error'; }).length;
    var pend = items.filter(function (i) { return i.status === 'pending' || i.status === 'uploading'; }).length;
    var s = $('summary');
    if (pend) s.textContent = '上傳中…（剩 ' + pend + ' 個）';
    else if (err) s.textContent = '已上傳 ' + doneThisRun + ' 個檔案到「傳檔」，' + err + ' 個失敗';
    else s.textContent = '已上傳 ' + doneThisRun + ' 個檔案到「傳檔」';
    s.style.color = (!pend && err) ? 'var(--err)' : (!pend ? 'var(--ok)' : '');
    $('btnRetry').classList.toggle('hidden', !!pend || !err);
    $('btnClear').classList.toggle('hidden', !!pend);
    var f = localStorage.getItem(LS.folder);
    if (f && !pend && doneThisRun) { $('lnkFolder').href = f; $('lnkFolder').classList.remove('hidden'); }
  }

  // ---------- 佇列處理 ----------
  var finished = []; // 本次已完成（已從 DB 移除）的項目，只為顯示
  function processQueue() {
    if (busy) return Promise.resolve();
    var c = cfg();
    if (!c.url || !c.key) {
      return dbAll().then(function (items) {
        if (items.length) { items.forEach(function (i) { paint(i); }); $('summary').textContent = '有 ' + items.length + ' 個檔案等待上傳，請先完成設定'; }
        showSettings(true);
      });
    }
    busy = true;
    return dbAll().then(function (items) {
      items.forEach(function (i) { paint(i); });
      var todo = items.filter(function (i) { return i.status === 'pending' || i.status === 'uploading'; });
      summarize(items.concat(finished));
      return todo.reduce(function (p, it) { return p.then(function () { return uploadOne(it); }); }, Promise.resolve());
    }).then(function () { return dbAll(); }).then(function (items) {
      busy = false; summarize(items.concat(finished));
    }).catch(function (e) { busy = false; $('summary').textContent = '發生錯誤：' + e.message; });
  }
  function uploadOne(it) {
    var c = cfg();
    it.status = 'uploading'; paint(it, 0);
    return maybeCompress(it).then(function (src) {
      if (src.blob.size > MAX_BYTES) throw new Error('檔案太大（' + fmtSize(src.blob.size) + '），上限約 35 MB，請直接用雲端硬碟 App 上傳');
      return toBase64(src.blob).then(function (b64) {
        return post(c.url, { key: c.key, name: src.name, mimeType: src.type || 'application/octet-stream', data: b64 }, function (p) { paint(it, p * 0.95); });
      });
    }).then(function (res) {
      it.status = 'done'; it.url = res.url; it.name = res.name || it.name; doneThisRun++;
      if (res.folderUrl) localStorage.setItem(LS.folder, res.folderUrl);
      finished.push({ id: it.id, status: 'done' });
      paint(it); return dbDel(it.id);
    }).catch(function (e) {
      it.status = 'error'; it.error = e.message; paint(it); return dbPut(it);
    });
  }
  function enqueue(fileList) {
    var now = Date.now(), arr = Array.prototype.slice.call(fileList || []);
    if (!arr.length) return;
    return arr.reduce(function (p, f, i) {
      return p.then(function () {
        return dbPut({ id: now.toString(36) + '-m' + i + '-' + Math.random().toString(36).slice(2, 7), source: 'pick', createdAt: now + i, name: f.name || ('檔案-' + (i + 1)), type: f.type || 'application/octet-stream', size: f.size, blob: f, status: 'pending' });
      });
    }, Promise.resolve()).then(processQueue);
  }

  // ---------- 事件 ----------
  $('btnSettings').onclick = function () { showSettings($('settings').classList.contains('hidden')); };
  $('inShowKey').onchange = function () { $('inKey').type = this.checked ? 'text' : 'password'; };
  $('btnSave').onclick = function () {
    var u = $('inUrl').value.trim(), k = $('inKey').value.trim();
    if (!validUrl(u)) return setMsg($('settingsMsg'), '網址格式不對，應該是 https://script.google.com/macros/s/…/exec', false);
    if (!k) return setMsg($('settingsMsg'), '請輸入金鑰', false);
    localStorage.setItem(LS.url, u); localStorage.setItem(LS.key, k); localStorage.setItem(LS.compress, $('inCompress').checked ? '1' : '0');
    setMsg($('settingsMsg'), '已儲存 ✅', true);
    setTimeout(function () { showSettings(false); processQueue(); }, 600);
  };
  $('btnTest').onclick = function () {
    var u = $('inUrl').value.trim(), k = $('inKey').value.trim(), m = $('settingsMsg');
    if (!validUrl(u)) return setMsg(m, '網址格式不對，應該是 https://script.google.com/macros/s/…/exec', false);
    setMsg(m, '測試中…', true); m.className = 'msg';
    post(u, { key: k, action: 'ping' }).then(function (r) {
      if (r.folderUrl) localStorage.setItem(LS.folder, r.folderUrl);
      setMsg(m, '連線成功 ✅ 金鑰正確，可以開始上傳', true);
    }).catch(function (e) { setMsg(m, '連線失敗 ❌ ' + e.message, false); });
  };
  $('btnPick').onclick = function () { $('picker').click(); };
  $('picker').onchange = function () { enqueue(this.files); this.value = ''; };
  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); if (ev === 'drop' || e.target === drop) drop.classList.remove('over'); }); });
  document.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) enqueue(e.dataTransfer.files); });
  $('btnRetry').onclick = function () {
    dbAll().then(function (items) {
      return items.filter(function (i) { return i.status === 'error'; }).reduce(function (p, i) { i.status = 'pending'; i.error = ''; return p.then(function () { return dbPut(i); }); }, Promise.resolve());
    }).then(processQueue);
  };
  $('btnClear').onclick = function () {
    dbAll().then(function (items) { return Promise.all(items.filter(function (i) { return i.status === 'error'; }).map(function (i) { return dbDel(i.id); })); })
      .then(function () { $('list').innerHTML = ''; finished = []; doneThisRun = 0; $('progressCard').classList.add('hidden'); $('lnkFolder').classList.add('hidden'); });
  };

  // ---------- 啟動 ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function (e) { console.warn('SW 註冊失敗', e); });
  var qs = new URLSearchParams(location.search);
  if (qs.get('error')) { $('progressCard').classList.remove('hidden'); $('summary').textContent = '接收分享失敗：' + qs.get('error'); }
  if (qs.has('shared')) history.replaceState(null, '', location.pathname); // 清掉網址參數，避免重新整理重複處理
  if (!cfg().url || !cfg().key) showSettings(true);
  processQueue();
})();
