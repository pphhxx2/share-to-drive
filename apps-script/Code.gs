/**
 * 傳檔 — Share to Google Drive 後端（Google Apps Script 網頁應用程式）
 *
 * 使用方式：
 *   1. 貼上本檔，先執行一次 setup()，授權後到「執行紀錄」複製金鑰。
 *   2. 部署 > 新增部署作業 > 網頁應用程式；執行身分：我；存取權：所有人。
 *
 * 用戶端以 Content-Type: text/plain 送出 JSON（避免 CORS 預檢）：
 *   { key, name, mimeType, data(base64) }
 * 回應：{ ok:true, name, url, folderUrl } 或 { ok:false, error }
 */

var FOLDER_NAME = '傳檔';
var PROP_KEY = 'SECRET_KEY';
var PROP_FOLDER = 'FOLDER_ID';
var TIME_ZONE = 'Asia/Taipei';

/** 第一次使用請手動執行：產生隨機金鑰並建立資料夾。 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(PROP_KEY);
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty(PROP_KEY, key);
  }
  var folder = getFolder_();
  Logger.log('你的金鑰（SECRET KEY）：' + key);
  Logger.log('上傳資料夾：' + folder.getUrl());
  return key;
}

/** 若金鑰外洩，執行此函式換一把新金鑰（之後要在 App 設定中更新）。 */
function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_KEY);
  return setup();
}

function doGet(e) {
  return json_({ ok: true, service: 'share-to-drive', folder: FOLDER_NAME, time: new Date().toISOString() });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error('沒有收到資料');
    var req;
    try { req = JSON.parse(e.postData.contents); } catch (err) { throw new Error('資料格式錯誤（不是 JSON）'); }

    var secret = PropertiesService.getScriptProperties().getProperty(PROP_KEY);
    if (!secret) throw new Error('伺服器尚未設定金鑰，請先執行 setup()');
    if (!req.key || !safeEqual_(String(req.key), secret)) throw new Error('金鑰錯誤');

    var folder = getFolder_();

    // 測試連線：只驗證金鑰，不存檔
    if (req.action === 'ping') {
      return json_({ ok: true, ping: true, folderUrl: folder.getUrl() });
    }

    if (!req.data) throw new Error('缺少檔案內容');
    var mimeType = String(req.mimeType || 'application/octet-stream');
    var name = sanitizeName_(req.name || ('檔案-' + stamp_()));
    var bytes = Utilities.base64Decode(String(req.data));
    var finalName = uniqueName_(folder, name);
    var blob = Utilities.newBlob(bytes, mimeType, finalName);
    var file = folder.createFile(blob);
    return json_({ ok: true, name: file.getName(), url: file.getUrl(), folderUrl: folder.getUrl(), size: bytes.length });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/** 找到或建立「傳檔」資料夾（在我的雲端硬碟根目錄），並快取 ID。 */
function getFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_FOLDER);
  if (id) {
    try {
      var f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (err) { /* 資料夾被刪了，重新找 */ }
  }
  var root = DriveApp.getRootFolder();
  var it = root.getFoldersByName(FOLDER_NAME);
  var folder = null;
  while (it.hasNext()) {
    var cand = it.next();
    if (!cand.isTrashed()) { folder = cand; break; }
  }
  if (!folder) folder = root.createFolder(FOLDER_NAME);
  props.setProperty(PROP_FOLDER, folder.getId());
  return folder;
}

function uniqueName_(folder, name) {
  if (!folder.getFilesByName(name).hasNext()) return name;
  var candidate = stamp_() + '-' + name;
  var n = 2;
  while (folder.getFilesByName(candidate).hasNext()) {
    candidate = stamp_() + '-' + n + '-' + name;
    n++;
  }
  return candidate;
}

function stamp_() {
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyyMMdd-HHmmss');
}

function sanitizeName_(name) {
  var s = String(name).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (s.length > 200) s = s.slice(0, 200);
  return s || ('檔案-' + stamp_());
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
