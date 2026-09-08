"use strict";
/* Синхронизация с Google Drive (замена FolderSync).
   Приложение само пишет снапшот прямо в ОДИН файл «Финансы — Монетки.json» в папке
   vault через Drive API — без ручного экспорта и без сторонних синхронизаторов.

   Направление v1: только запись (push) телефон → Drive. IndexedDB остаётся источником
   истины (js/db.js), оффлайн-ввод не трогаем — синк отложенный.

   Аутентификация: Google Identity Services (GIS), token-флоу в браузере, scope
   drive.file (доступ только к файлам, которые приложение создало или пользователь
   выбрал через Picker). Клиент-секрет НЕ используется. Ключи берутся из
   window.GDRIVE_CONFIG (config.local.js, в .gitignore).

   Привязка файла (fileId/folderId) хранится в meta (IndexedDB) под ключом "gdrive",
   поэтому переживает перезапуск. Google-скрипты грузятся лениво с их CDN — офлайн
   и до подключения ничего лишнего не загружается. */

const GDrive = (function () {
  const CFG = window.GDRIVE_CONFIG || null;

  // Привязка к файлу vault: { fileId, folderId, fileName }. null пока не подключено.
  let binding = null;

  // GIS token client и кэш токена (~1 час; тихо перезапрашиваем при истечении).
  let tokenClient = null;
  let accessToken = null;
  let tokenExp = 0; // ms epoch

  const GIS_SRC = "https://accounts.google.com/gsi/client";
  const GAPI_SRC = "https://apis.google.com/js/api.js";
  const FOLDER_MIME = "application/vnd.google-apps.folder";

  // ---- утилиты ----
  function isConfigured() {
    return !!(CFG && CFG.clientId && CFG.apiKey &&
      CFG.clientId.indexOf("ВАШ_") < 0 && CFG.apiKey.indexOf("ВАШ_") < 0);
  }
  function isConnected() { return !!(binding && binding.fileId); }
  function fileName() { return (CFG && CFG.fileName) || "Финансы — Монетки.json"; }
  function getBinding() { return binding; }

  // Номер проекта Google (appId для Picker) — часть client_id до дефиса.
  function appId() { return isConfigured() ? String(CFG.clientId).split("-")[0] : ""; }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const found = Array.prototype.find.call(document.scripts, (s) => s.src === src);
      if (found) {
        if (found.dataset.loaded === "1") return res();
        found.addEventListener("load", () => res());
        found.addEventListener("error", () => rej(new Error("Не загрузился " + src)));
        return;
      }
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = () => { s.dataset.loaded = "1"; res(); };
      s.onerror = () => rej(new Error("Не загрузился " + src));
      document.head.appendChild(s);
    });
  }

  // ---- восстановление привязки ----
  async function load() {
    try { const m = await DB.get("meta", "gdrive"); if (m && m.value) binding = m.value; }
    catch (e) { /* нет привязки — ок */ }
    return binding;
  }

  // ---- аутентификация (GIS) ----
  async function ensureGis() {
    await loadScript(GIS_SRC);
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CFG.clientId,
        scope: CFG.scope || "https://www.googleapis.com/auth/drive.file",
        callback: () => {}, // назначаем на каждый запрос ниже
      });
    }
  }

  // interactive:false → тихий рефреш (prompt:"none"), без UI. Отклоняется, если нужен консент.
  function getToken(interactive) {
    if (accessToken && Date.now() < tokenExp - 60000) return Promise.resolve(accessToken);
    return ensureGis().then(() => new Promise((res, rej) => {
      tokenClient.callback = (resp) => {
        if (resp && resp.error) { rej(new Error(resp.error)); return; }
        accessToken = resp.access_token;
        tokenExp = Date.now() + ((resp.expires_in ? resp.expires_in : 3600) * 1000);
        res(accessToken);
      };
      try { tokenClient.requestAccessToken({ prompt: interactive ? "" : "none" }); }
      catch (e) { rej(e); }
    }));
  }

  // ---- Google Picker ----
  async function ensurePicker() {
    await loadScript(GAPI_SRC);
    await new Promise((res, rej) => {
      try { gapi.load("picker", { callback: res, onerror: () => rej(new Error("Picker не загрузился")) }); }
      catch (e) { rej(e); }
    });
  }

  // Открыть Picker: пользователь выбирает существующий файл-снапшот ИЛИ папку vault
  // (тогда создадим файл в ней). Возвращает выбранный документ или бросает Error("cancelled").
  function showPicker(token) {
    return new Promise((res, rej) => {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMode(google.picker.DocsViewMode.LIST);
      const picker = new google.picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(CFG.apiKey)
        .setAppId(appId())
        .addView(view)
        .setTitle("Выбери «" + fileName() + "» или папку vault")
        .setCallback((data) => {
          const A = google.picker.Action;
          if (data.action === A.PICKED) res((data.docs && data.docs[0]) || null);
          else if (data.action === A.CANCEL) rej(new Error("cancelled"));
        })
        .build();
      picker.setVisible(true);
    });
  }

  // ---- Drive REST ----
  async function createFile(folderId) {
    const token = await getToken(false);
    const meta = { name: fileName(), mimeType: "application/json" };
    if (folderId) meta.parents = [folderId];
    const r = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,parents", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(meta),
    });
    if (!r.ok) throw new Error("Создание файла: HTTP " + r.status);
    return r.json();
  }

  function doUpdate(id, text, token) {
    return fetch("https://www.googleapis.com/upload/drive/v3/files/" +
      encodeURIComponent(id) + "?uploadType=media", {
      method: "PATCH",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: text,
    });
  }

  // ---- публичное API ----

  // Разовая привязка: консент → Picker → сохранить fileId/folderId в meta.
  async function connect() {
    if (!isConfigured()) throw new Error("Нет ключей Google (config.local.js)");
    const token = await getToken(true);
    await ensurePicker();
    const doc = await showPicker(token); // бросит "cancelled", если закрыли
    if (!doc || !doc.id) throw new Error("cancelled");

    let fileId, folderId = null;
    if (doc.mimeType === FOLDER_MIME) {
      folderId = doc.id;
      const created = await createFile(folderId);
      fileId = created.id;
    } else {
      fileId = doc.id;
      folderId = doc.parentId || null; // best-effort
    }
    binding = { fileId, folderId, fileName: fileName() };
    await DB.put("meta", { key: "gdrive", value: binding });
    return binding;
  }

  // Залить снапшот в привязанный файл (files.update, media). Тихий рефреш токена и один
  // ретрай на 401. Бросает Error при неудаче — вызывающий держит данные в очереди.
  async function push(text) {
    if (!isConnected()) throw new Error("Google Drive не подключён");
    let token = await getToken(false);
    let r = await doUpdate(binding.fileId, text, token);
    if (r.status === 401) { // токен протух — сбросить и перезапросить тихо
      accessToken = null; tokenExp = 0;
      token = await getToken(false);
      r = await doUpdate(binding.fileId, text, token);
    }
    if (r.status === 404) throw new Error("Файл в Drive не найден — переподключи (404)");
    if (!r.ok) throw new Error("Заливка: HTTP " + r.status);
    return true;
  }

  // Забыть привязку и отозвать токен.
  async function disconnect() {
    binding = null;
    await DB.del("meta", "gdrive").catch(() => {});
    if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch (e) { /* ок */ }
    }
    accessToken = null; tokenExp = 0;
  }

  return { isConfigured, isConnected, fileName, getBinding, load, connect, push, disconnect };
})();

window.GDrive = GDrive;
