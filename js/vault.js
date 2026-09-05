"use strict";
/* Экспорт/импорт данных vault (§4, §6) — путь «без сервера», файл носит FolderSync.
   IndexedDB (источник истины) ⇄ ОДИН файл «Финансы — Монетки.json».

   ЕДИНЫЙ ФОРМАТ на всех платформах — один JSON-файл со всеми данными (счета,
   категории, операции, план месяца). Так десктоп и телефон работают с ОДНИМ и тем
   же файлом (без рассинхрона наборов файлов), а round-trip точный: сохраняются id,
   null/булевы, любые символы в заметках.
     • Десктоп (showDirectoryPicker): пишем файл в выбранную папку vault
       (сохранённый handle папки → тихая перезапись).
     • Телефон (нет доступа к папке): тот же файл через сохранённый file-handle →
       showSaveFilePicker → download (дальше FolderSync донесёт в vault).
   Импорт (parseJSON/importFromDir) читает этот же файл обратно. Старый Markdown-
   экспорт (`.md` с Dataview-полями) ещё поддержан на ЧТЕНИЕ ради миграции (parseVault). */

const Vault = (function () {
  const FNAME_JSON = "Финансы — Монетки.json";

  const pad = (n) => String(n).padStart(2, "0");
  const nowStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));

  // ---- сборка снапшота (§4) ----
  function buildJSON(state) {
    return JSON.stringify({
      app: "Монетки",
      schema: 1,
      updated: nowStr(),
      meta: { plan: state.meta && state.meta.plan != null ? state.meta.plan : 0 },
      accounts: state.accounts,
      categories: state.categories,
      transactions: state.transactions,
    }, null, 2);
  }

  // ---- File System Access ----
  async function ensurePerm(handle) {
    if (!handle || !handle.queryPermission) return false;
    const o = { mode: "readwrite" };
    if ((await handle.queryPermission(o)) === "granted") return true;
    return (await handle.requestPermission(o)) === "granted";
  }
  async function writeHandle(handle, text) { const w = await handle.createWritable(); await w.write(text); await w.close(); }
  async function writeInDir(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    await writeHandle(fh, text);
  }
  function download(text, name, type) {
    const blob = new Blob([text], { type: (type || "application/json") + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name || FNAME_JSON; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function capabilities() {
    return {
      saveFilePicker: typeof window.showSaveFilePicker === "function",
      directoryPicker: typeof window.showDirectoryPicker === "function",
      download: true,
    };
  }

  // Главный экспорт. mode: "dir"|"handle"|"picked"|"download".
  async function exportVault(state) {
    const json = buildJSON(state);

    // 1) режим папки — сохранённый handle папки (тихая перезапись в vault)
    const savedDir = await DB.get("meta", "vaultDir").catch(() => null);
    if (savedDir && savedDir.value) {
      try { if (await ensurePerm(savedDir.value)) { await writeInDir(savedDir.value, FNAME_JSON, json); return { mode: "dir" }; } }
      catch (e) { /* папка недоступна — предложим выбрать заново ниже */ }
    }
    // 1b) API папок есть, но папка ещё не выбрана — выбрать один раз
    if (typeof window.showDirectoryPicker === "function") {
      const dir = await window.showDirectoryPicker({ mode: "readwrite" });
      await writeInDir(dir, FNAME_JSON, json);
      try { await DB.put("meta", { key: "vaultDir", value: dir }); } catch (e) { /* не сериализуется — ок */ }
      return { mode: "dir" };
    }

    // 2) один файл — сохранённый handle (только .json; старый .md-handle игнорируем)
    const saved = await DB.get("meta", "vaultHandle").catch(() => null);
    if (saved && saved.value && saved.value.name && /\.json$/i.test(saved.value.name)) {
      try { if (await ensurePerm(saved.value)) { await writeHandle(saved.value, json); return { mode: "handle" }; } }
      catch (e) { /* handle протух */ }
    }
    // 2b) выбор файла один раз
    if (typeof window.showSaveFilePicker === "function") {
      const handle = await window.showSaveFilePicker({
        suggestedName: FNAME_JSON,
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      await writeHandle(handle, json);
      try { await DB.put("meta", { key: "vaultHandle", value: handle }); } catch (e) { /* ок */ }
      return { mode: "picked" };
    }
    // 3) обычная загрузка
    download(json, FNAME_JSON);
    return { mode: "download" };
  }

  async function forgetHandle() {
    await DB.del("meta", "vaultHandle").catch(() => {});
    await DB.del("meta", "vaultDir").catch(() => {});
  }

  // ---- импорт/восстановление ----
  const num = (v) => { const s = String(v == null ? "" : v).trim().replace(",", "."); if (s === "") return null; const n = parseFloat(s); return isNaN(n) ? null : n; };

  // Основной формат: JSON-снапшот. Возвращает {accounts, categories, transactions, plan}.
  function parseJSON(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return { accounts: [], categories: [], transactions: [], plan: null, error: true }; }
    if (!obj || typeof obj !== "object") return { accounts: [], categories: [], transactions: [], plan: null };
    const arr = (x) => (Array.isArray(x) ? x : []);
    const accounts = arr(obj.accounts).map((a, i) => ({
      id: a.id || uid(), name: String(a.name == null ? "" : a.name),
      balance: Number(a.balance) || 0, currency: a.currency || "UAH", kind: a.kind || "card",
      plan: a.plan == null || a.plan === "" ? null : Number(a.plan),
      archived: !!a.archived, order: a.order == null ? i : a.order,
    })).filter((a) => a.name);
    const categories = arr(obj.categories).map((c, i) => ({
      id: c.id || uid(), name: String(c.name == null ? "" : c.name),
      limit: c.limit == null || c.limit === "" ? null : Number(c.limit),
      emoji: c.emoji || "🪙", group: c.group || null, archived: !!c.archived,
      order: c.order == null ? i : c.order,
    })).filter((c) => c.name);
    const transactions = arr(obj.transactions).map((t) => {
      const o = {
        id: t.id || uid(), ts: t.ts || "", amount: Number(t.amount) || 0,
        cat: String(t.cat == null ? "" : t.cat), acc: String(t.acc == null ? "" : t.acc),
        cur: t.cur || "UAH", type: t.type || "expense", synced: t.synced !== false,
      };
      if (t.to) o.to = t.to;
      if (t.note) o.note = t.note;
      return o;
    });
    const plan = obj.meta && obj.meta.plan != null ? Number(obj.meta.plan) : null;
    return { accounts, categories, transactions, plan };
  }

  // Legacy-формат: Markdown с Dataview-инлайн-полями (старый экспорт). Только ЧТЕНИЕ.
  // Принимает массив текстов (совмещённый или помесячные + _Счета + _Категории).
  function parseVault(texts) {
    const accounts = [], categories = [], transactions = [];
    let ai = 0, ci = 0;
    const seen = { acc: new Set(), cat: new Set(), tx: new Set() };

    for (const text of [].concat(texts)) {
      for (const raw of String(text == null ? "" : text).split(/\r?\n/)) {
        const line = raw.trim();
        if (line.slice(0, 2) !== "- ") continue;
        const pairs = {};
        let m; const re = /\[([a-zA-Z]+)::\s*([^\]]*?)\]/g;
        while ((m = re.exec(line))) pairs[m[1]] = m[2].trim();

        if ("account" in pairs) {
          const name = pairs.account; if (!name || seen.acc.has(name)) continue; seen.acc.add(name);
          accounts.push({
            id: uid(), name, balance: num(pairs.balance) || 0, currency: pairs.cur || "UAH",
            kind: pairs.kind || "card", plan: num(pairs.plan),
            archived: pairs.archived === "true", order: ai++,
          });
        } else if ("category" in pairs) {
          const name = pairs.category; if (!name || seen.cat.has(name)) continue; seen.cat.add(name);
          categories.push({
            id: uid(), name, limit: num(pairs.limit), emoji: pairs.emoji || "🪙",
            group: pairs.group || null, archived: pairs.archived === "true", order: ci++,
          });
        } else if ("amount" in pairs) {
          const amount = num(pairs.amount); if (amount === null) continue;
          const dm = line.match(/^-\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/);
          const ts = dm ? `${dm[1]}T${dm[2].padStart(5, "0")}:00` : "";
          const key = [ts, amount, pairs.cat || "", pairs.acc || "", pairs.to || "", pairs.type || ""].join("|");
          if (seen.tx.has(key)) continue; seen.tx.add(key);
          const li = line.lastIndexOf("]");
          const note = li >= 0 ? line.slice(li + 1).trim() : "";
          const t = {
            id: uid(), ts, amount, cat: pairs.cat || "", acc: pairs.acc || "",
            cur: pairs.cur || "UAH", type: pairs.type || "expense", synced: true,
          };
          if (pairs.to) t.to = pairs.to;
          if (note) t.note = note;
          transactions.push(t);
        }
      }
    }
    return { accounts, categories, transactions, plan: null };
  }

  // Автоопределение формата одного файла: JSON или legacy Markdown.
  function parseAny(text) {
    const t = String(text == null ? "" : text).trim();
    if (t[0] === "{" || t[0] === "[") return parseJSON(text);
    return parseVault([text]);
  }

  // Похоже на старый Markdown-экспорт Монеток?
  function isLegacyVaultFile(name) {
    return /^Финансы — .+\.md$/i.test(name) || name === "_Счета.md" || name === "_Категории.md";
  }

  // Импорт из ПАПКИ: предпочитаем JSON (источник правды), иначе fallback на legacy .md.
  async function importFromDir(dir) {
    let jsonText = null; const mdTexts = [];
    for await (const h of dir.values()) {
      if (h.kind !== "file") continue;
      try {
        if (h.name === FNAME_JSON) { jsonText = await (await h.getFile()).text(); }
        else if (isLegacyVaultFile(h.name)) { mdTexts.push(await (await h.getFile()).text()); }
      } catch (e) { /* пропускаем нечитаемый */ }
    }
    if (jsonText != null) return { data: parseJSON(jsonText), files: 1, format: "json" };
    if (mdTexts.length) return { data: parseVault(mdTexts), files: mdTexts.length, format: "md" };
    return { data: { accounts: [], categories: [], transactions: [], plan: null }, files: 0, format: null };
  }

  return { buildJSON, parseJSON, parseVault, parseAny, exportVault, importFromDir, capabilities, forgetHandle };
})();

window.Vault = Vault;
