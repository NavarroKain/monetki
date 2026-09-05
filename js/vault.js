"use strict";
/* Экспорт данных в vault (§4, §6) — путь «без сервера», данные забирает FolderSync.
   IndexedDB (источник истины) → Markdown с Dataview-инлайн-полями. Приложение файл
   НЕ читает (синхронизация односторонняя), поэтому размер файла на приложение не влияет.

   Два режима, выбираются по возможностям устройства:
     • Папка (помесячно) — есть showDirectoryPicker (десктоп): пишет
       «Финансы — ГГГГ-ММ.md» по месяцам + _Счета.md + _Категории.md. Масштабируется,
       Obsidian/Dataview остаются лёгкими.
     • Один файл — телефон без доступа к папке: снапшот в один файл (перезапись),
       через сохранённый handle → showSaveFilePicker → download (дальше FolderSync). */

const Vault = (function () {
  const FNAME = "Финансы — Монетки.md";

  const pad = (n) => String(n).padStart(2, "0");
  const dt = (iso) => (iso ? iso.slice(0, 10) + " " + iso.slice(11, 16) : "");
  const nowStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const esc = (s) => String(s == null ? "" : s).replace(/[\[\]]/g, "");

  // ---- строители секций (§4) ----
  function txLine(t) {
    let s = `- ${dt(t.ts)} [amount:: ${t.amount}] [cat:: ${esc(t.cat)}] [acc:: ${esc(t.acc)}] [cur:: ${t.cur || "UAH"}] [type:: ${t.type || "expense"}]`;
    if (t.type === "transfer" && t.to) s += ` [to:: ${esc(t.to)}]`;
    if (t.note) s += ` ${esc(t.note)}`;
    return s;
  }
  function accountLines(state) {
    return state.accounts.slice().sort((x, y) => x.order - y.order).map((a) => {
      let s = `- [account:: ${esc(a.name)}] [balance:: ${a.balance}] [cur:: ${a.currency}] [kind:: ${a.kind}]`;
      if (a.plan != null) s += ` [plan:: ${a.plan}]`;
      if (a.archived) s += ` [archived:: true]`;
      return s;
    });
  }
  function categoryLines(state) {
    return state.categories.slice().sort((x, y) => x.order - y.order).map((c) => {
      let s = `- [category:: ${esc(c.name)}] [limit:: ${c.limit == null ? "" : c.limit}] [emoji:: ${c.emoji}]`;
      if (c.group) s += ` [group:: ${esc(c.group)}]`;
      if (c.archived) s += ` [archived:: true]`;
      return s;
    });
  }
  function groupByMonth(txs) {
    const by = {};
    for (const t of txs.slice().sort((a, b) => (a.ts < b.ts ? -1 : 1))) {
      const m = (t.ts || "").slice(0, 7); (by[m] = by[m] || []).push(t);
    }
    return by;
  }

  function monthMd(month, txs) {
    const L = ["---", "app: Монетки", `month: ${month}`, `updated: ${nowStr()}`, "---", "",
      `# Финансы — ${month}`, "", "> Автоэкспорт из PWA. Формат — Dataview-инлайн-поля.", ""];
    for (const t of txs) L.push(txLine(t));
    L.push("");
    return L.join("\n");
  }
  function accountsMd(state) {
    return ["---", "app: Монетки", `updated: ${nowStr()}`, "---", "", "# Счета", ""].concat(accountLines(state), "").join("\n");
  }
  function categoriesMd(state) {
    return ["---", "app: Монетки", `updated: ${nowStr()}`, "---", "", "# Категории", ""].concat(categoryLines(state), "").join("\n");
  }

  // Один совмещённый файл (фолбэк для телефона).
  function buildMarkdown(state) {
    const L = ["---", "app: Монетки", `updated: ${nowStr()}`, "---", "",
      "# Финансы — данные Монеток", "",
      "> Автоэкспорт из PWA. Формат — Dataview-инлайн-поля. Правки лучше делать в приложении.", "",
      "## Операции", ""];
    const by = groupByMonth(state.transactions);
    const months = Object.keys(by).sort();
    if (!months.length) L.push("_пока нет операций_");
    for (const m of months) { L.push(`### ${m}`); for (const t of by[m]) L.push(txLine(t)); L.push(""); }
    L.push("## Счета", "");
    L.push.apply(L, accountLines(state)); L.push("");
    L.push("## Категории", "");
    L.push.apply(L, categoryLines(state)); L.push("");
    return L.join("\n");
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
  async function writeDir(dir, state) {
    const by = groupByMonth(state.transactions);
    for (const m of Object.keys(by)) await writeInDir(dir, `Финансы — ${m}.md`, monthMd(m, by[m]));
    await writeInDir(dir, "_Счета.md", accountsMd(state));
    await writeInDir(dir, "_Категории.md", categoriesMd(state));
  }
  function download(text, name) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name || FNAME; document.body.appendChild(a); a.click();
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
    // 1) режим папки (помесячно) — сохранённый handle папки
    const savedDir = await DB.get("meta", "vaultDir").catch(() => null);
    if (savedDir && savedDir.value) {
      try { if (await ensurePerm(savedDir.value)) { await writeDir(savedDir.value, state); return { mode: "dir" }; } }
      catch (e) { /* папка недоступна — предложим выбрать заново ниже */ }
    }
    // 1b) если API папок есть, но папка ещё не выбрана — выбрать один раз
    if (typeof window.showDirectoryPicker === "function") {
      const dir = await window.showDirectoryPicker({ mode: "readwrite" });
      await writeDir(dir, state);
      try { await DB.put("meta", { key: "vaultDir", value: dir }); } catch (e) { /* не сериализуется — ок */ }
      return { mode: "dir" };
    }

    // 2) один файл — сохранённый handle
    const md = buildMarkdown(state);
    const saved = await DB.get("meta", "vaultHandle").catch(() => null);
    if (saved && saved.value) {
      try { if (await ensurePerm(saved.value)) { await writeHandle(saved.value, md); return { mode: "handle" }; } }
      catch (e) { /* handle протух */ }
    }
    // 2b) выбор файла один раз
    if (typeof window.showSaveFilePicker === "function") {
      const handle = await window.showSaveFilePicker({
        suggestedName: FNAME,
        types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
      });
      await writeHandle(handle, md);
      try { await DB.put("meta", { key: "vaultHandle", value: handle }); } catch (e) { /* ок */ }
      return { mode: "picked" };
    }
    // 3) обычная загрузка
    download(md);
    return { mode: "download" };
  }

  async function forgetHandle() {
    await DB.del("meta", "vaultHandle").catch(() => {});
    await DB.del("meta", "vaultDir").catch(() => {});
  }

  return { buildMarkdown, monthMd, accountsMd, categoriesMd, exportVault, capabilities, forgetHandle };
})();

window.Vault = Vault;
