"use strict";
/* Экспорт данных в vault (§4, §6) — путь «без сервера», данные забирает FolderSync.
   IndexedDB (источник истины) → Markdown с Dataview-инлайн-полями.
   Сохранение с деградацией по возможностям устройства:
     1) сохранённый handle (File System Access) → тихая перезапись файла;
     2) showSaveFilePicker → выбор файла один раз, дальше перезапись;
     3) download → файл уходит в «Загрузки», FolderSync синхронит папку.
   Экспорт — полный снапшот (перезапись целиком), поэтому дубли/аппенд не нужны. */

const Vault = (function () {
  const FNAME = "Финансы — Монетки.md";

  const pad = (n) => String(n).padStart(2, "0");
  const dt = (iso) => { // "2026-09-05T12:30:00" → "2026-09-05 12:30"
    if (!iso) return "";
    return iso.slice(0, 10) + " " + iso.slice(11, 16);
  };
  const nowStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const esc = (s) => String(s == null ? "" : s).replace(/[\[\]]/g, ""); // инлайн-поля не любят скобки

  // Одна операция = одна строка (§4).
  function txLine(t) {
    let s = `- ${dt(t.ts)} [amount:: ${t.amount}] [cat:: ${esc(t.cat)}] [acc:: ${esc(t.acc)}] [cur:: ${t.cur || "UAH"}] [type:: ${t.type || "expense"}]`;
    if (t.type === "transfer" && t.to) s += ` [to:: ${esc(t.to)}]`;
    if (t.note) s += ` ${esc(t.note)}`;
    return s;
  }

  function buildMarkdown(state) {
    const L = [];
    L.push("---");
    L.push("app: Монетки");
    L.push(`updated: ${nowStr()}`);
    L.push("---");
    L.push("");
    L.push("# Финансы — данные Монеток");
    L.push("");
    L.push("> Автоэкспорт из PWA. Формат — Dataview-инлайн-поля. Правки лучше делать в приложении.");
    L.push("");

    // Операции по месяцам (свежие сверху секций-месяцев по возрастанию для читаемости).
    L.push("## Операции");
    L.push("");
    const txs = state.transactions.slice().sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const byMonth = {};
    for (const t of txs) { const m = (t.ts || "").slice(0, 7); (byMonth[m] = byMonth[m] || []).push(t); }
    const months = Object.keys(byMonth).sort();
    if (!months.length) L.push("_пока нет операций_");
    for (const m of months) {
      L.push(`### ${m}`);
      for (const t of byMonth[m]) L.push(txLine(t));
      L.push("");
    }

    // Счета (§4 — инлайн-поля). Источники доходов помечены kind:: income.
    L.push("## Счета");
    L.push("");
    for (const a of state.accounts.slice().sort((x, y) => x.order - y.order)) {
      let s = `- [account:: ${esc(a.name)}] [balance:: ${a.balance}] [cur:: ${a.currency}] [kind:: ${a.kind}]`;
      if (a.plan != null) s += ` [plan:: ${a.plan}]`;
      if (a.archived) s += ` [archived:: true]`;
      L.push(s);
    }
    L.push("");

    // Категории (§4 — инлайн-поля).
    L.push("## Категории");
    L.push("");
    for (const c of state.categories.slice().sort((x, y) => x.order - y.order)) {
      let s = `- [category:: ${esc(c.name)}] [limit:: ${c.limit == null ? "" : c.limit}] [emoji:: ${c.emoji}]`;
      if (c.group) s += ` [group:: ${esc(c.group)}]`;
      if (c.archived) s += ` [archived:: true]`;
      L.push(s);
    }
    L.push("");
    return L.join("\n");
  }

  // ---- File System Access helpers ----
  async function ensurePerm(handle) {
    if (!handle || !handle.queryPermission) return false;
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    if ((await handle.requestPermission(opts)) === "granted") return true;
    return false;
  }
  async function writeHandle(handle, text) {
    const w = await handle.createWritable();
    await w.write(text); await w.close();
  }
  function download(text) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = FNAME; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // Возможности устройства — для диагностики в UI.
  function capabilities() {
    return {
      saveFilePicker: typeof window.showSaveFilePicker === "function",
      directoryPicker: typeof window.showDirectoryPicker === "function",
      download: true,
    };
  }

  // Главный экспорт. Возвращает { mode: "handle"|"picked"|"download" }.
  async function exportVault(state) {
    const md = buildMarkdown(state);

    // 1) сохранённый handle
    const saved = await DB.get("meta", "vaultHandle").catch(() => null);
    if (saved && saved.value) {
      try {
        if (await ensurePerm(saved.value)) { await writeHandle(saved.value, md); return { mode: "handle" }; }
      } catch (e) { /* handle протух — пойдём выбирать заново */ }
    }

    // 2) выбор файла (десктоп + Android с поддержкой)
    if (typeof window.showSaveFilePicker === "function") {
      const handle = await window.showSaveFilePicker({
        suggestedName: FNAME,
        types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
      });
      await writeHandle(handle, md);
      try { await DB.put("meta", { key: "vaultHandle", value: handle }); } catch (e) { /* некоторые handle не сериализуются — не критично */ }
      return { mode: "picked" };
    }

    // 3) обычная загрузка файла
    download(md);
    return { mode: "download" };
  }

  // Сбросить привязанный файл (сменить назначение экспорта).
  async function forgetHandle() { await DB.del("meta", "vaultHandle").catch(() => {}); }

  return { buildMarkdown, exportVault, capabilities, forgetHandle };
})();

window.Vault = Vault;
