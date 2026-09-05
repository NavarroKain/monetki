"use strict";
/* «Монетки» — логика приложения (Фаза 1).
   Дашборд + лист ввода (расход/доход/перевод/баланс) + редакторы справочников (§5b).
   Источник истины — IndexedDB (db.js). Память state — быстрое зеркало для рендера. */

const App = (function () {
  // ---------- состояние ----------
  const state = {
    accounts: [],       // счета + источники доходов (kind:"income")
    categories: [],
    transactions: [],
    meta: { plan: 0, rates: { UAH: 1, USD: 41.5, EUR: 45, ts: null, base: true }, theme: null },
  };

  const $ = (id) => document.getElementById(id);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));

  // ---------- форматирование ----------
  const f0 = (n) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(n));
  const f2 = (n) => new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  const curSym = (c) => (c === "USD" ? "$" : c === "EUR" ? "€" : c === "UAH" ? "₴" : c);

  const MONTH = (() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); })();
  const monthTitle = () => {
    const d = new Date(MONTH + "-01T00:00:00");
    const s = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(d);
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  function nowTs() {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ---------- выборки ----------
  const realAccounts = () => state.accounts.filter((a) => a.kind !== "income" && !a.archived).sort((a, b) => a.order - b.order);
  const incomeSources = () => state.accounts.filter((a) => a.kind === "income" && !a.archived).sort((a, b) => a.order - b.order);
  const activeCats = () => state.categories.filter((c) => !c.archived).sort((a, b) => a.order - b.order);
  const accByName = (n) => state.accounts.find((a) => a.name === n);
  const catByName = (n) => state.categories.find((c) => c.name === n);

  function spentOf(name) {
    let s = 0;
    for (const t of state.transactions) {
      if (t.type !== "expense") continue;
      if ((t.ts || "").slice(0, 7) !== MONTH) continue;
      if (t.cat === name) s += -t.amount;
    }
    return s;
  }
  function rate(cur) { const r = state.meta.rates || {}; return r[cur] || 1; }
  function balanceTotalUAH() {
    let b = 0;
    for (const a of realAccounts()) b += a.balance * rate(a.currency);
    return b;
  }
  const unsyncedCount = () => state.transactions.filter((t) => !t.synced).length;

  // ---------- логика цвета монетки (§3) ----------
  function coinStyle(sp, lim) {
    if (lim === null || lim === 0) return { bg: "var(--coin-green)", fill: 0, txt: "var(--coin-green)" };
    if (sp === 0) return { bg: "var(--coin-grey)", fill: 0, txt: "var(--muted)" };
    if (sp > lim) return { bg: "var(--red)", fill: 100, txt: "var(--red)" };
    return { bg: "var(--coin-grey)", fill: Math.min(100, sp / lim * 100), fillc: "var(--orange)", txt: "var(--orange)" };
  }

  // ---------- жест: тап / удержание ----------
  function bindPress(el, onTap, onHold) {
    let timer = null, held = false, sx = 0, sy = 0, moved = false;
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => {
      held = false; moved = false; sx = e.clientX; sy = e.clientY;
      if (onHold) timer = setTimeout(() => { held = true; if (navigator.vibrate) navigator.vibrate(12); onHold(); }, 480);
    });
    el.addEventListener("pointermove", (e) => {
      if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) { moved = true; clearTimeout(timer); }
    });
    el.addEventListener("pointerup", () => { clearTimeout(timer); if (!held && !moved) onTap(); });
    el.addEventListener("pointercancel", () => clearTimeout(timer));
    el.addEventListener("pointerleave", () => clearTimeout(timer));
  }

  // ---------- рендер ----------
  function render() {
    $("month").textContent = monthTitle();

    $("tBal").textContent = f0(balanceTotalUAH()) + " ₴";
    $("tExp").textContent = f0(activeCats().reduce((s, c) => s + spentOf(c.name), 0)) + " ₴";
    $("tPlan").textContent = f0(state.meta.plan || 0) + " ₴";

    // курс
    $("rate").textContent = Rates.label(state.meta.rates);

    // индикатор синка
    const n = unsyncedCount(), sync = $("sync");
    sync.className = "sync" + (n > 0 ? " pending" : " ok");
    $("syncTxt").textContent = n > 0 ? (n + " не синхр.") : "синхр.";

    // монетки категорий
    const coins = $("coins"); coins.innerHTML = "";
    for (const c of activeCats()) {
      const sp = spentOf(c.name), st = coinStyle(sp, c.limit);
      const b = document.createElement("button"); b.className = "coin-wrap";
      b.innerHTML = `<div class="coin" style="background:${st.bg}">${st.fill > 0 && st.fill < 100 ? `<div class="fill" style="height:${st.fill}%;background:${st.fillc}"></div>` : ""}<span class="em">${c.emoji}</span></div>
        <div class="cname">${esc(c.name)}</div>
        <div class="cspent" style="color:${st.txt}">${sp ? f0(sp) : 0}</div>
        <div class="climit">${c.limit ? "/ " + f0(c.limit) : "·"}</div>`;
      bindPress(b, () => openSheet("expense", c.name), () => editCategory(c));
      coins.appendChild(b);
    }
    // «＋ новая категория»
    const addC = document.createElement("button"); addC.className = "coin-wrap";
    addC.innerHTML = `<div class="coin add">＋</div><div class="cname">Категория</div><div class="cspent">&nbsp;</div><div class="climit">·</div>`;
    addC.onclick = () => editCategory(null);
    coins.appendChild(addC);

    // счета
    const accs = $("accs"); accs.innerHTML = "";
    for (const a of realAccounts()) {
      const d = document.createElement("button"); d.className = "acc";
      d.innerHTML = `<div class="dot">${curSym(a.currency)}</div><div class="an">${esc(a.name)}</div><div class="ab">${f2(a.balance)} ${curSym(a.currency)}</div>`;
      bindPress(d, () => editAccount(a), () => editAccount(a));
      accs.appendChild(d);
    }
    const addA = document.createElement("button"); addA.className = "acc add";
    addA.innerHTML = `<div>＋</div><div class="an">счёт</div>`;
    addA.onclick = () => editAccount(null);
    accs.appendChild(addA);

    // последние операции
    const rec = $("recent"); rec.innerHTML = "";
    const items = state.transactions.slice().sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 7);
    if (!items.length) rec.innerHTML = `<div class="rrow"><span class="s">Пока пусто — тапни монетку категории</span></div>`;
    for (const t of items) {
      const isT = t.type === "transfer";
      const col = isT ? "var(--muted)" : (t.amount < 0 ? "var(--red)" : "var(--coin-green)");
      const sign = isT ? "" : (t.amount < 0 ? "−" : "+");
      const label = isT ? `${esc(t.acc)} → ${esc(t.to)}` : esc(t.cat);
      const r = document.createElement("div"); r.className = "rrow";
      r.innerHTML = `<div><div class="l">${label}</div><div class="s">${esc(t.acc)}${isT ? "" : " · " + (t.ts || "").slice(5, 10).replace("-", ".")}</div></div><b style="color:${col}">${sign}${f2(Math.abs(t.amount))} ${curSym(t.cur)}</b>`;
      rec.appendChild(r);
    }
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }

  // ---------- persistence ----------
  async function putTx(t) { state.transactions.push(t); await DB.put("transactions", t); }
  async function putAcc(a) {
    const i = state.accounts.findIndex((x) => x.id === a.id);
    if (i >= 0) state.accounts[i] = a; else state.accounts.push(a);
    await DB.put("accounts", a);
  }
  async function putCat(c) {
    const i = state.categories.findIndex((x) => x.id === c.id);
    if (i >= 0) state.categories[i] = c; else state.categories.push(c);
    await DB.put("categories", c);
  }
  async function adj(name, delta) {
    const a = accByName(name); if (!a) return;
    a.balance = Math.round((a.balance + delta) * 100) / 100;
    await DB.put("accounts", a);
  }
  async function setMeta(key, value) { state.meta[key] = value; await DB.put("meta", { key, value }); }

  // ---------- лист ввода ----------
  const sheet = $("sheet"), editor = $("editor"), scrim = $("scrim");
  let mode = "expense", amt = "0", selCat = null, selInc = null, selAcc = null, selTo = null, selBalAcc = null;

  function openSheet(m, cat) {
    mode = m; amt = "0";
    selCat = cat || (activeCats()[0] && activeCats()[0].name) || null;
    selInc = (incomeSources()[0] && incomeSources()[0].name) || null;
    if (!selAcc || !accByName(selAcc) || accByName(selAcc).kind === "income") {
      const ra = realAccounts(); selAcc = ra[0] ? ra[0].name : null;
    }
    selTo = null;
    selBalAcc = (realAccounts()[0] && realAccounts()[0].name) || null;
    document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    buildSheet();
    openScrim(); sheet.classList.add("on");
  }
  function openScrim() { scrim.classList.add("on"); }
  function closeAll() { scrim.classList.remove("on"); sheet.classList.remove("on"); editor.classList.remove("on"); }
  scrim.onclick = closeAll;

  function chip(text, on, onclick, extra) {
    const b = document.createElement("button");
    b.className = "chip" + (on ? " on" : "") + (extra ? " " + extra : "");
    b.textContent = text; b.onclick = onclick; return b;
  }

  function buildSheet() {
    const emEl = $("shEm"), title = $("shTitle"), sub = $("shSub");
    const pickWrap = $("pickWrap"), pickChips = $("pickChips"), pickLabel = $("pickLabel");
    const accLabel = $("accLabel"), accChips = $("accChips");
    const toWrap = $("toWrap"), toChips = $("toChips");
    pickChips.innerHTML = ""; accChips.innerHTML = ""; toChips.innerHTML = "";
    toWrap.style.display = "none"; pickWrap.style.display = "none";

    if (mode === "expense" || mode === "income") {
      pickWrap.style.display = "";
      if (mode === "expense") {
        pickLabel.textContent = "Категория";
        for (const c of activeCats()) pickChips.appendChild(chip(c.name, c.name === selCat, () => { selCat = c.name; buildSheet(); }));
        pickChips.appendChild(chip("＋", false, () => editCategory(null), "plus"));
        const c = catByName(selCat) || activeCats()[0];
        emEl.textContent = c ? c.emoji : "🪙"; emEl.style.background = "var(--surface-2)";
        title.textContent = "Расход"; sub.textContent = selCat || "—";
        accLabel.textContent = "Списать со счёта";
      } else {
        pickLabel.textContent = "Источник дохода";
        for (const s of incomeSources()) pickChips.appendChild(chip(s.name, s.name === selInc, () => { selInc = s.name; buildSheet(); }));
        pickChips.appendChild(chip("＋", false, () => editIncome(null), "plus"));
        emEl.textContent = "＋"; emEl.style.background = "var(--surface-2)";
        title.textContent = "Доход"; sub.textContent = selInc || "—";
        accLabel.textContent = "Зачислить на счёт";
      }
      for (const a of realAccounts()) accChips.appendChild(chip(a.name, a.name === selAcc, () => { selAcc = a.name; buildSheet(); }));
    } else if (mode === "transfer") {
      emEl.textContent = "⇄"; emEl.style.background = "var(--surface-2)";
      title.textContent = "Перевод"; sub.textContent = "между счетами";
      accLabel.textContent = "Со счёта";
      for (const a of realAccounts()) accChips.appendChild(chip(a.name, a.name === selAcc, () => { selAcc = a.name; buildSheet(); }));
      toWrap.style.display = "";
      if (!selTo || selTo === selAcc) { const o = realAccounts().find((a) => a.name !== selAcc); selTo = o ? o.name : null; }
      for (const a of realAccounts()) toChips.appendChild(chip(a.name, a.name === selTo, () => { selTo = a.name; buildSheet(); }));
    } else { // balance
      emEl.textContent = "✎"; emEl.style.background = "var(--surface-2)";
      title.textContent = "Новый баланс"; sub.textContent = selBalAcc || "—";
      accLabel.textContent = "Счёт";
      for (const a of realAccounts()) accChips.appendChild(chip(a.name, a.name === selBalAcc, () => { selBalAcc = a.name; buildSheet(); }));
    }
    $("shAmt").textContent = amt;
    buildPad();
    $("save").disabled = (parseFloat(amt) || 0) <= 0 && mode !== "balance";
  }

  function buildPad() {
    const pad = $("pad"); pad.innerHTML = "";
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].forEach((k) => {
      const b = document.createElement("button"); b.textContent = k; b.onclick = () => press(k); pad.appendChild(b);
    });
  }
  function press(k) {
    if (k === "⌫") amt = amt.length > 1 ? amt.slice(0, -1) : "0";
    else if (k === ".") { if (!amt.includes(".")) amt += "."; }
    else amt = amt === "0" ? k : amt + k;
    if (amt.includes(".") && amt.split(".")[1].length > 2) amt = amt.slice(0, -1);
    $("shAmt").textContent = amt;
    $("save").disabled = (parseFloat(amt) || 0) <= 0 && mode !== "balance";
  }

  $("save").onclick = async () => {
    const v = parseFloat(amt) || 0;
    if (mode === "balance") {
      const a = accByName(selBalAcc); if (!a) return;
      a.balance = Math.round(v * 100) / 100; await DB.put("accounts", a);
      toast(`Баланс «${selBalAcc}» = ${f2(v)}`);
    } else {
      if (v <= 0) return;
      if (mode === "expense") {
        if (!selCat || !selAcc) { toast("Выбери категорию и счёт"); return; }
        const cur = accByName(selAcc).currency;
        await putTx({ id: uid(), ts: nowTs(), amount: -v, cat: selCat, acc: selAcc, cur, type: "expense", synced: false });
        await adj(selAcc, -v); toast(`− ${f2(v)} ${curSym(cur)} · ${selCat}`);
      } else if (mode === "income") {
        if (!selInc || !selAcc) { toast("Выбери источник и счёт"); return; }
        const cur = accByName(selAcc).currency;
        await putTx({ id: uid(), ts: nowTs(), amount: v, cat: selInc, acc: selAcc, cur, type: "income", synced: false });
        await adj(selAcc, v); toast(`+ ${f2(v)} ${curSym(cur)} · ${selInc}`);
      } else if (mode === "transfer") {
        if (!selAcc || !selTo) { toast("Выбери счета"); return; }
        if (selAcc === selTo) { toast("Счета совпадают"); return; }
        const cur = accByName(selAcc).currency;
        await putTx({ id: uid(), ts: nowTs(), amount: -v, cat: "Перевод", acc: selAcc, to: selTo, cur, type: "transfer", synced: false });
        await adj(selAcc, -v); await adj(selTo, v);
        toast(`${selAcc} → ${selTo}: ${f2(v)}`);
      }
    }
    closeAll(); render();
  };

  document.querySelectorAll("#modes button").forEach((b) => b.onclick = () => { openSheet(b.dataset.m, selCat); });

  $("btnAdd").onclick = () => openSheet("expense");
  $("btnIncome").onclick = () => openSheet("income");
  $("btnTransfer").onclick = () => openSheet("transfer");

  // ---------- редакторы справочников (§5b) ----------
  const EMOJIS = ["🛒","🍔","🚌","🛍️","🏠","🎬","🧰","🎁","💊","🏋️","🧾","🏢","🧥","💱","🪙","📊","☕","⛽","📱","✈️","🎓","💡","🎵","💳","💰","🐶","🚗","🍺"];

  function openEditor(html, wire) {
    $("editorBody").innerHTML = html;
    if (wire) wire();
    openScrim(); editor.classList.add("on");
  }

  function editCategory(cat) {
    const isNew = !cat;
    const c = cat || { id: uid(), name: "", limit: null, emoji: "🪙", group: null, archived: false, order: state.categories.length };
    const hasTx = !isNew && state.transactions.some((t) => t.cat === c.name);
    openEditor(`
      <div class="form">
        <div style="font-weight:800;font-size:16px;margin-bottom:2px">${isNew ? "Новая категория" : "Категория"}</div>
        <label>Название</label>
        <input class="input" id="eName" value="${esc(c.name)}" placeholder="Напр. Продукты" autocomplete="off">
        <label>Эмодзи</label>
        <div class="emojis" id="eEmojis"></div>
        <input class="input" id="eEmoji" value="${esc(c.emoji)}" maxlength="4" style="margin-top:6px" placeholder="или введи свой">
        <label>Лимит в месяц (пусто = без лимита)</label>
        <input class="input" id="eLimit" inputmode="decimal" value="${c.limit ?? ""}" placeholder="напр. 5000">
        <div class="form-actions">
          ${!isNew ? `<button class="btn danger" id="eDel">${hasTx ? "Скрыть" : "Удалить"}</button>` : ""}
          <button class="btn ghost" id="eCancel">Отмена</button>
          <button class="btn primary" id="eSave">Сохранить</button>
        </div>
        <div class="hint">Цвет монетки считается автоматически: без лимита — зелёная, с лимитом — заполняется оранжевым по мере трат, превышение — красная.</div>
      </div>`, () => {
      const box = $("eEmojis");
      EMOJIS.forEach((e) => {
        const b = document.createElement("button"); b.className = "emoji-opt" + (e === c.emoji ? " on" : ""); b.textContent = e;
        b.onclick = () => { $("eEmoji").value = e; box.querySelectorAll(".emoji-opt").forEach((x) => x.classList.remove("on")); b.classList.add("on"); };
        box.appendChild(b);
      });
      $("eCancel").onclick = closeAll;
      $("eSave").onclick = async () => {
        const name = $("eName").value.trim(); if (!name) { toast("Введи название"); return; }
        const dup = state.categories.find((x) => x.name === name && x.id !== c.id && !x.archived);
        if (dup) { toast("Такая категория уже есть"); return; }
        const limRaw = $("eLimit").value.trim().replace(",", ".");
        c.name = name; c.emoji = ($("eEmoji").value.trim() || "🪙"); c.limit = limRaw === "" ? null : (parseFloat(limRaw) || null);
        await putCat(c); closeAll(); render(); toast(isNew ? "Категория добавлена" : "Сохранено");
      };
      const del = $("eDel");
      if (del) del.onclick = async () => {
        if (hasTx) { c.archived = true; await putCat(c); toast("Категория скрыта"); }
        else { state.categories = state.categories.filter((x) => x.id !== c.id); await DB.del("categories", c.id); toast("Категория удалена"); }
        closeAll(); render();
      };
    });
  }

  function editAccount(acc) {
    const isNew = !acc;
    const a = acc || { id: uid(), name: "", balance: 0, currency: "UAH", kind: "card", plan: null, archived: false, order: realAccounts().length };
    const hasTx = !isNew && state.transactions.some((t) => t.acc === a.name || t.to === a.name);
    const KINDS = [["cash", "Наличные"], ["card", "Карта"], ["deposit", "Депозит"], ["fop", "ФОП"]];
    const CURS = ["UAH", "USD", "EUR"];
    openEditor(`
      <div class="form">
        <div style="font-weight:800;font-size:16px;margin-bottom:2px">${isNew ? "Новый счёт" : "Счёт"}</div>
        <label>Название</label>
        <input class="input" id="eName" value="${esc(a.name)}" placeholder="Напр. Карта" autocomplete="off">
        <div class="row2">
          <div><label>Валюта</label><div class="seg" id="eCur">${CURS.map((x) => `<button data-v="${x}" class="${x === a.currency ? "on" : ""}">${curSym(x)} ${x}</button>`).join("")}</div></div>
        </div>
        <label>Тип</label>
        <div class="seg" id="eKind">${KINDS.map(([v, l]) => `<button data-v="${v}" class="${v === a.kind ? "on" : ""}">${l}</button>`).join("")}</div>
        <label>${isNew ? "Стартовый баланс" : "Баланс"}</label>
        <input class="input" id="eBal" inputmode="decimal" value="${a.balance}" placeholder="0">
        <div class="form-actions">
          ${!isNew ? `<button class="btn danger" id="eDel">${hasTx ? "Скрыть" : "Удалить"}</button>` : ""}
          <button class="btn ghost" id="eCancel">Отмена</button>
          <button class="btn primary" id="eSave">Сохранить</button>
        </div>
        <div class="hint">Правка баланса здесь меняет остаток без создания операции (§2). Сводный «Баланс» приводится к гривне по актуальному курсу.</div>
      </div>`, () => {
      let cur = a.currency, kind = a.kind;
      $("eCur").querySelectorAll("button").forEach((b) => b.onclick = () => { cur = b.dataset.v; $("eCur").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); });
      $("eKind").querySelectorAll("button").forEach((b) => b.onclick = () => { kind = b.dataset.v; $("eKind").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); });
      $("eCancel").onclick = closeAll;
      $("eSave").onclick = async () => {
        const name = $("eName").value.trim(); if (!name) { toast("Введи название"); return; }
        const dup = state.accounts.find((x) => x.name === name && x.id !== a.id && !x.archived);
        if (dup) { toast("Такой счёт уже есть"); return; }
        a.name = name; a.currency = cur; a.kind = kind;
        a.balance = Math.round((parseFloat($("eBal").value.trim().replace(",", ".")) || 0) * 100) / 100;
        await putAcc(a); closeAll(); render(); toast(isNew ? "Счёт добавлен" : "Сохранено");
      };
      const del = $("eDel");
      if (del) del.onclick = async () => {
        if (hasTx) { a.archived = true; await putAcc(a); toast("Счёт скрыт"); }
        else { state.accounts = state.accounts.filter((x) => x.id !== a.id); await DB.del("accounts", a.id); toast("Счёт удалён"); }
        closeAll(); render();
      };
    });
  }

  function editIncome(inc) {
    const isNew = !inc;
    const a = inc || { id: uid(), name: "", balance: 0, currency: "UAH", kind: "income", plan: null, archived: false, order: 100 + incomeSources().length };
    const hasTx = !isNew && state.transactions.some((t) => t.type === "income" && t.cat === a.name);
    openEditor(`
      <div class="form">
        <div style="font-weight:800;font-size:16px;margin-bottom:2px">${isNew ? "Новый источник дохода" : "Источник дохода"}</div>
        <label>Название</label>
        <input class="input" id="eName" value="${esc(a.name)}" placeholder="Напр. Зарплата" autocomplete="off">
        <label>План в месяц (необязательно)</label>
        <input class="input" id="ePlan" inputmode="decimal" value="${a.plan ?? ""}" placeholder="напр. 50000">
        <div class="form-actions">
          ${!isNew ? `<button class="btn danger" id="eDel">${hasTx ? "Скрыть" : "Удалить"}</button>` : ""}
          <button class="btn ghost" id="eCancel">Отмена</button>
          <button class="btn primary" id="eSave">Сохранить</button>
        </div>
      </div>`, () => {
      $("eCancel").onclick = closeAll;
      $("eSave").onclick = async () => {
        const name = $("eName").value.trim(); if (!name) { toast("Введи название"); return; }
        const planRaw = $("ePlan").value.trim().replace(",", ".");
        a.name = name; a.plan = planRaw === "" ? null : (parseFloat(planRaw) || null);
        await putAcc(a); selInc = a.name; closeAll(); render(); toast(isNew ? "Источник добавлен" : "Сохранено");
      };
      const del = $("eDel");
      if (del) del.onclick = async () => {
        if (hasTx) { a.archived = true; await putAcc(a); toast("Источник скрыт"); }
        else { state.accounts = state.accounts.filter((x) => x.id !== a.id); await DB.del("accounts", a.id); toast("Источник удалён"); }
        closeAll(); render();
      };
    });
  }

  function manageIncomes() {
    const list = incomeSources();
    openEditor(`
      <div class="form">
        <div style="font-weight:800;font-size:16px;margin-bottom:8px">Источники доходов</div>
        <div class="list" id="incList">
          ${list.length ? list.map((s) => `<div class="litem" data-id="${s.id}"><span class="ln">${esc(s.name)}</span><span class="ls">${s.plan ? "план " + f0(s.plan) : ""}</span></div>`).join("") : `<div class="hint">Пока нет источников</div>`}
        </div>
        <div class="form-actions">
          <button class="btn ghost" id="eCancel">Закрыть</button>
          <button class="btn primary" id="eAdd">＋ Добавить</button>
        </div>
      </div>`, () => {
      $("eCancel").onclick = closeAll;
      $("eAdd").onclick = () => editIncome(null);
      document.querySelectorAll("#incList .litem").forEach((el) => el.onclick = () => {
        const s = state.accounts.find((x) => x.id === el.dataset.id); if (s) editIncome(s);
      });
    });
  }

  function editPlan() {
    openEditor(`
      <div class="form">
        <div style="font-weight:800;font-size:16px;margin-bottom:2px">План месяца</div>
        <label>Плановые траты, ₴</label>
        <input class="input" id="ePlan" inputmode="decimal" value="${state.meta.plan || 0}">
        <div class="form-actions">
          <button class="btn ghost" id="eCancel">Отмена</button>
          <button class="btn primary" id="eSave">Сохранить</button>
        </div>
      </div>`, () => {
      $("eCancel").onclick = closeAll;
      $("eSave").onclick = async () => {
        await setMeta("plan", Math.round(parseFloat($("ePlan").value.trim().replace(",", ".")) || 0));
        closeAll(); render(); toast("План обновлён");
      };
    });
  }

  // ---------- меню ----------
  const menu = $("menu");
  $("menuBtn").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("on"); };
  document.body.addEventListener("click", () => menu.classList.remove("on"));
  menu.querySelectorAll("button").forEach((b) => b.onclick = async () => {
    const act = b.dataset.act;
    if (act === "incomes") manageIncomes();
    else if (act === "plan") editPlan();
    else if (act === "theme") {
      const r = document.documentElement, cur = r.getAttribute("data-theme");
      const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme:dark)").matches;
      const next = dark ? "light" : "dark"; r.setAttribute("data-theme", next); await setMeta("theme", next);
    } else if (act === "export") {
      await doExport();
    } else if (act === "exportReset") {
      await Vault.forgetHandle(); toast("Файл экспорта сброшен — при следующем экспорте выберешь заново");
    } else if (act === "reset") {
      if (confirm("Сбросить ВСЕ данные к начальным? Операции будут удалены.")) {
        await DB.resetAll(); await boot(true); toast("Данные сброшены");
      }
    }
  });

  // ---------- тост ----------
  let toastT;
  function toast(m) { const el = $("toast"); el.textContent = m; el.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("on"), 1900); }

  // ---------- экспорт в vault (§4, §6) ----------
  async function doExport() {
    try {
      const res = await Vault.exportVault(state);
      // Полный снапшот ушёл в vault — помечаем все операции синхронизированными.
      const unsynced = state.transactions.filter((t) => !t.synced);
      for (const t of unsynced) { t.synced = true; await DB.put("transactions", t); }
      render();
      toast(res.mode === "download" ? "Файл сохранён — FolderSync донесёт в vault"
        : res.mode === "picked" ? "Экспортировано, файл привязан для перезаписи"
        : "Экспортировано в vault");
    } catch (e) {
      if (e && e.name === "AbortError") return; // пользователь закрыл выбор файла
      console.error(e); toast("Не удалось экспортировать: " + ((e && e.message) || e));
    }
  }

  // ---------- курсы ----------
  async function refreshRates(force) {
    try {
      const fresh = await Rates.refresh(state.meta.rates, force);
      if (fresh && fresh !== state.meta.rates) { await setMeta("rates", fresh); render(); }
    } catch (e) { /* офлайн/ошибка — остаёмся на кэше, не мешаем работе */ }
  }

  // ---------- загрузка ----------
  async function boot(reload) {
    await DB.ensureSeeded();
    const [accounts, categories, transactions, plan, rates, theme] = await Promise.all([
      DB.getAll("accounts"), DB.getAll("categories"), DB.getAll("transactions"),
      DB.get("meta", "plan"), DB.get("meta", "rates"), DB.get("meta", "theme"),
    ]);
    state.accounts = accounts; state.categories = categories; state.transactions = transactions;
    state.meta.plan = plan ? plan.value : window.SEED.plan;
    state.meta.rates = rates ? rates.value : window.SEED.rates;
    state.meta.theme = theme ? theme.value : null;
    if (state.meta.theme) document.documentElement.setAttribute("data-theme", state.meta.theme);
    render();
    if (!reload) refreshRates(false);
  }

  function start() {
    boot(false).catch((e) => { console.error(e); toast("Ошибка загрузки данных"); });
    // Service Worker — офлайн-оболочка (§7). Работает только по http(s).
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
    }
    window.addEventListener("online", () => refreshRates(true));
  }

  return { start, _state: state };
})();

App.start();
