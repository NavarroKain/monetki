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
  const round2 = (n) => Math.round(n * 100) / 100;

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

  // ---------- drag-ввод: перетаскивание счёта на категорию/счёт (бриф drag) ----------
  // Константы — дефолты Android ViewConfiguration, вынесены в конфиг для тюнинга.
  const DND = {
    TOUCH_SLOP: 8,   // px — порог начала движения (меньше — дрожание, игнорируем)
    LONG_PRESS: 500, // мс — удержание «поднимает» монетку (drag в любую сторону)
  };

  // true пока монетка «поднята» или тащится — на это время гасим нативный скролл.
  let dragActive = false;
  // Скролл ряда счетов останавливаем только когда идёт наш жест; обычный
  // горизонтальный скролл (dragActive=false) работает как раньше.
  document.addEventListener("touchmove", (e) => { if (dragActive) e.preventDefault(); }, { passive: false });

  // Валидные цели дропа: монетки категорий (#coins) и счета (#accs), кроме источника.
  function dropTargets() {
    return [...document.querySelectorAll("#coins .coin-wrap[data-cat], #accs .acc[data-acc]")];
  }

  // Жест на монетке счёта: тап → onTap, удержание-на-месте → onHold (редактор),
  // удержание-и-повёл / сдвиг вверх → drag на категорию (расход) или счёт (перевод).
  function bindAccountGesture(el, accName, onTap, onHold) {
    let timer = null, lifted = false, dragging = false, moved = false, canceled = false;
    let sx = 0, sy = 0, pid = null, ghost = null, overEl = null;

    function highlightAll(on) {
      dropTargets().forEach((t) => {
        if (t.dataset.acc === accName) return;        // сам источник — не цель
        t.classList.toggle("drop-target", on);
      });
    }
    function makeGhost() {
      const g = el.cloneNode(true);
      g.className = "acc drag-ghost";
      g.style.width = el.offsetWidth + "px";
      document.body.appendChild(g);
      return g;
    }
    function moveGhost(x, y) { if (ghost) { ghost.style.left = x + "px"; ghost.style.top = y + "px"; } }
    function hitTest(x, y) {
      // ghost с pointer-events:none — elementFromPoint его игнорирует.
      const under = document.elementFromPoint(x, y);
      if (!under) return null;
      const cat = under.closest("#coins .coin-wrap[data-cat]");
      if (cat) return { kind: "category", name: cat.dataset.cat, el: cat };
      const acc = under.closest("#accs .acc[data-acc]");
      if (acc && acc.dataset.acc !== accName) return { kind: "account", name: acc.dataset.acc, el: acc };
      return null;                                    // мимо или на себя
    }
    function startDrag(x, y) {
      dragging = true; dragActive = true;
      try { el.setPointerCapture(pid); } catch (e) {}
      el.classList.add("drag-src");
      ghost = makeGhost(); moveGhost(x, y);
      highlightAll(true);
      if (navigator.vibrate) navigator.vibrate(12);   // отклик при захвате
    }
    function setOver(newOver) {
      if (newOver === overEl) return;
      if (overEl) overEl.classList.remove("drop-over");
      if (newOver) { newOver.classList.add("drop-over"); if (navigator.vibrate) navigator.vibrate(8); }
      overEl = newOver;
    }
    function endDrag(hit) {
      if (ghost) { ghost.remove(); ghost = null; }
      highlightAll(false); setOver(null);
      el.classList.remove("drag-src");
      dragging = false; lifted = false; dragActive = false;
      if (!hit) return;                               // мимо цели / на себя → отмена
      if (hit.kind === "category") openSheetForDrop(accName, "category", hit.name);
      else openSheetForDrop(accName, "account", hit.name);
    }
    function cleanup() {
      clearTimeout(timer);
      if (dragging) { if (ghost) { ghost.remove(); ghost = null; } highlightAll(false); setOver(null); el.classList.remove("drag-src"); }
      lifted = false; dragging = false; dragActive = false;
    }

    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button > 0) return;
      lifted = false; dragging = false; moved = false; canceled = false;
      sx = e.clientX; sy = e.clientY; pid = e.pointerId;
      timer = setTimeout(() => {                       // долгое удержание «поднимает» монетку
        lifted = true; dragActive = true;             // скролл замирает — можно вести в любую сторону
        if (navigator.vibrate) navigator.vibrate(12);
      }, DND.LONG_PRESS);
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pid || canceled) return;
      if (dragging) {
        moveGhost(e.clientX, e.clientY);
        const hit = hitTest(e.clientX, e.clientY);
        setOver(hit ? hit.el : null);
        e.preventDefault();
        return;
      }
      const dx = e.clientX - sx, dy = e.clientY - sy;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (adx < DND.TOUCH_SLOP && ady < DND.TOUCH_SLOP) return;  // дрожание — ждём
      if (lifted) { clearTimeout(timer); startDrag(e.clientX, e.clientY); return; }  // поднято → тащим
      if (dy < 0 && ady > adx) {                        // сдвиг вверх к категориям → сразу drag
        clearTimeout(timer); startDrag(e.clientX, e.clientY);
      } else {                                          // вбок/вниз → это скролл ряда, не наш жест
        clearTimeout(timer); moved = true; canceled = true;
      }
    });
    el.addEventListener("pointerup", (e) => {
      if (e.pointerId !== pid) return;
      clearTimeout(timer);
      if (dragging) { endDrag(hitTest(e.clientX, e.clientY)); return; }
      if (lifted) { lifted = false; dragActive = false; onHold(); return; }  // подняли и отпустили на месте → редактор
      if (!moved && !canceled) onTap();
    });
    el.addEventListener("pointercancel", (e) => { if (e.pointerId === pid) { cleanup(); canceled = true; } });
  }

  // Открыть лист ввода с предвыбором из drag'а. Сумму пользователь вводит сам.
  function openSheetForDrop(source, targetKind, targetName) {
    if (targetKind === "category") {
      selAcc = source;                 // openSheet сохранит валидный selAcc
      openSheet("expense", targetName);
    } else {                           // счёт → счёт: перевод
      selAcc = source;
      openSheet("transfer");           // внутри selTo сбрасывается
      selTo = targetName;
      buildSheet();                    // перерисовать чипы под выбранные счета
    }
  }

  // ---------- рендер ----------
  function render() {
    $("month").textContent = monthTitle();

    $("tBal").textContent = f0(balanceTotalUAH()) + " ₴";
    $("tExp").textContent = f0(activeCats().reduce((s, c) => s + spentOf(c.name), 0)) + " ₴";
    $("tPlan").textContent = f0(state.meta.plan || 0) + " ₴";

    // курс
    $("rate").textContent = Rates.label(state.meta.rates);

    // индикатор синка (см. renderSync — учитывает Drive/офлайн/состояние заливки)
    renderSync();

    // монетки категорий
    const coins = $("coins"); coins.innerHTML = "";
    for (const c of activeCats()) {
      const sp = spentOf(c.name), st = coinStyle(sp, c.limit);
      const b = document.createElement("button"); b.className = "coin-wrap"; b.dataset.cat = c.name;
      b.innerHTML = `<div class="coin" style="background:${st.bg}">${st.fill > 0 && st.fill < 100 ? `<div class="fill" style="height:${st.fill}%;background:${st.fillc}"></div>` : ""}<span class="em">${c.emoji}</span></div>
        <div class="cname">${esc(c.name)}</div>
        <div class="cspent" style="color:${st.txt}">${sp ? f0(sp) : 0}</div>
        <div class="climit">${c.limit ? "/ " + f0(c.limit) : "·"}</div>`;
      bindPress(b, () => showOperations("category", c.name), () => editCategory(c));
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
      const d = document.createElement("button"); d.className = "acc"; d.dataset.acc = a.name;
      d.innerHTML = `<div class="dot">${curSym(a.currency)}</div><div class="an">${esc(a.name)}</div><div class="ab">${f2(a.balance)} ${curSym(a.currency)}</div>`;
      bindAccountGesture(d, a.name, () => showOperations("account", a.name), () => editAccount(a));
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
    for (const t of items) rec.appendChild(opRow(t, true));
  }

  // строка операции для списков (последние операции, список по объекту)
  function opRow(t, withDate) {
    const isT = t.type === "transfer";
    const col = isT ? "var(--muted)" : (t.amount < 0 ? "var(--red)" : "var(--coin-green)");
    const sign = isT ? "" : (t.amount < 0 ? "−" : "+");
    const label = isT ? `${esc(t.acc)} → ${esc(t.to)}` : esc(t.cat);
    const date = withDate && !isT ? " · " + (t.ts || "").slice(5, 10).replace("-", ".") : "";
    const r = document.createElement("div"); r.className = "rrow";
    r.innerHTML = `<div><div class="l">${label}</div><div class="s">${esc(t.acc)}${date}</div></div><b style="color:${col}">${sign}${f2(Math.abs(t.amount))} ${curSym(t.cur)}</b>`;
    r.onclick = () => editOperation(t);
    return r;
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }

  // ---------- persistence ----------
  async function putTx(t) { state.transactions.push(t); await DB.put("transactions", t); scheduleSync(); }
  async function putAcc(a) {
    const i = state.accounts.findIndex((x) => x.id === a.id);
    if (i >= 0) state.accounts[i] = a; else state.accounts.push(a);
    await DB.put("accounts", a); scheduleSync();
  }
  async function putCat(c) {
    const i = state.categories.findIndex((x) => x.id === c.id);
    if (i >= 0) state.categories[i] = c; else state.categories.push(c);
    await DB.put("categories", c); scheduleSync();
  }
  async function adj(name, delta) {
    const a = accByName(name); if (!a) return;
    a.balance = round2(a.balance + delta);
    await DB.put("accounts", a);
  }
  // Влияние операции на балансы: dir=+1 применить, dir=-1 откатить (в памяти).
  function balanceApply(t, dir) {
    if (t.type === "transfer") {
      const from = accByName(t.acc), to = accByName(t.to);
      if (from) from.balance = round2(from.balance + dir * t.amount);       // amount < 0
      if (to) to.balance = round2(to.balance + dir * (-t.amount));
    } else {
      const a = accByName(t.acc);
      if (a) a.balance = round2(a.balance + dir * t.amount);                 // expense<0, income>0
    }
  }
  async function persistAccounts(names) {
    for (const n of [...new Set(names.filter(Boolean))]) { const a = accByName(n); if (a) await DB.put("accounts", a); }
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
    editor.classList.remove("on"); // не наслаивать лист ввода на редактор/список
    openScrim(); sheet.classList.add("on");
  }
  // Защита от «фантомного» click, который мобильные браузеры шлют вслед за тапом:
  // модалка открывается по pointerup, следом прилетает click в ту же точку — уже
  // по scrim — и мгновенно её закрывает. Игнорируем клики по scrim сразу после открытия.
  let scrimGuardUntil = 0;
  function openScrim() { scrim.classList.add("on"); document.documentElement.classList.add("modal-open"); document.body.classList.add("modal-open"); scrimGuardUntil = Date.now() + 450; }
  function closeAll() { scrim.classList.remove("on"); sheet.classList.remove("on"); editor.classList.remove("on"); document.documentElement.classList.remove("modal-open"); document.body.classList.remove("modal-open"); }
  scrim.onclick = () => { if (Date.now() < scrimGuardUntil) return; closeAll(); };

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
    closeAll(); render(); scheduleSync();
  };

  document.querySelectorAll("#modes button").forEach((b) => b.onclick = () => { openSheet(b.dataset.m, selCat); });

  $("btnAdd").onclick = () => openSheet("expense");
  $("btnIncome").onclick = () => openSheet("income");
  $("btnTransfer").onclick = () => openSheet("transfer");

  // Клик по индикатору синхронизации → ручной флаш. Если подключён Google Drive —
  // заливаем снапшот в файл vault; иначе фолбэк на файловый экспорт (десктоп/без Drive).
  const syncEl = $("sync");
  syncEl.title = "Синхронизировать сейчас";
  syncEl.setAttribute("role", "button");
  syncEl.setAttribute("tabindex", "0");
  const syncNow = () => { if (GDrive.isConnected()) flushToDrive(true); else doExport(); };
  syncEl.onclick = (e) => { e.stopPropagation(); syncNow(); };
  syncEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); syncNow(); } });

  // ---------- редакторы справочников (§5b) ----------
  const EMOJIS = ["🛒","🍔","🚌","🛍️","🏠","🎬","🧰","🎁","💊","🏋️","🧾","🏢","🧥","💱","🪙","📊","☕","⛽","📱","✈️","🎓","💡","🎵","💳","💰","🐶","🚗","🍺"];

  function openEditor(html, wire) {
    $("editorBody").innerHTML = html;
    if (wire) wire();
    sheet.classList.remove("on"); // не наслаивать редактор/список на лист ввода
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
        closeAll(); render(); scheduleSync();
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
        closeAll(); render(); scheduleSync();
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
        closeAll(); render(); scheduleSync();
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
        closeAll(); render(); scheduleSync(); toast("План обновлён");
      };
    });
  }

  // ---------- редактор операции (#2) ----------
  const optTag = (v, sel) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(v)}</option>`;
  function editOperation(t) {
    const type = t.type;
    const absv = Math.abs(t.amount);
    const dateVal = (t.ts || "").slice(0, 16);
    const title = type === "expense" ? "Расход" : type === "income" ? "Доход" : "Перевод";
    let body = `<div class="form"><div style="font-weight:800;font-size:16px;margin-bottom:2px">Операция · ${title}</div>`;
    if (type === "expense") {
      body += `<label>Категория</label><select class="input" id="eCat">${activeCats().map((c) => optTag(c.name, c.name === t.cat)).join("")}</select>`;
      body += `<label>Счёт</label><select class="input" id="eAcc">${realAccounts().map((a) => optTag(a.name, a.name === t.acc)).join("")}</select>`;
    } else if (type === "income") {
      body += `<label>Источник</label><select class="input" id="eInc">${incomeSources().map((a) => optTag(a.name, a.name === t.cat)).join("")}</select>`;
      body += `<label>Счёт</label><select class="input" id="eAcc">${realAccounts().map((a) => optTag(a.name, a.name === t.acc)).join("")}</select>`;
    } else {
      body += `<label>Со счёта</label><select class="input" id="eAcc">${realAccounts().map((a) => optTag(a.name, a.name === t.acc)).join("")}</select>`;
      body += `<label>На счёт</label><select class="input" id="eTo">${realAccounts().map((a) => optTag(a.name, a.name === t.to)).join("")}</select>`;
    }
    body += `<label>Сумма</label><input class="input" id="eAmt" inputmode="decimal" value="${absv}">`;
    body += `<label>Дата и время</label><input class="input" id="eDate" type="datetime-local" value="${dateVal}">`;
    if (type !== "transfer") body += `<label>Заметка</label><input class="input" id="eNote" value="${esc(t.note || "")}" placeholder="необязательно">`;
    body += `<div class="form-actions"><button class="btn danger" id="eDel">Удалить</button><button class="btn ghost" id="eCancel">Отмена</button><button class="btn primary" id="eSave">Сохранить</button></div></div>`;
    openEditor(body, () => {
      $("eCancel").onclick = closeAll;
      $("eDel").onclick = async () => {
        if (!confirm("Удалить эту операцию? Баланс вернётся к прежнему.")) return;
        balanceApply(t, -1);
        await persistAccounts([t.acc, t.to]);
        state.transactions = state.transactions.filter((x) => x.id !== t.id);
        await DB.del("transactions", t.id);
        closeAll(); render(); scheduleSync(); toast("Операция удалена");
      };
      $("eSave").onclick = async () => {
        const v = Math.abs(parseFloat($("eAmt").value.trim().replace(",", ".")) || 0);
        if (v <= 0) { toast("Введи сумму"); return; }
        const oldNames = [t.acc, t.to];
        balanceApply(t, -1); // откат старого влияния
        if (type === "expense") {
          t.cat = $("eCat").value; t.acc = $("eAcc").value; t.amount = -v; t.cur = accByName(t.acc).currency;
          t.note = $("eNote").value.trim() || undefined;
        } else if (type === "income") {
          t.cat = $("eInc").value; t.acc = $("eAcc").value; t.amount = v; t.cur = accByName(t.acc).currency;
          t.note = $("eNote").value.trim() || undefined;
        } else {
          const from = $("eAcc").value, to = $("eTo").value;
          if (from === to) { balanceApply(t, 1); toast("Счета совпадают"); return; }
          t.acc = from; t.to = to; t.amount = -v; t.cur = accByName(from).currency;
        }
        const d = $("eDate").value; if (d) t.ts = d.length === 16 ? d + ":00" : d;
        t.synced = false;
        balanceApply(t, 1); // применить новое влияние
        await persistAccounts([...oldNames, t.acc, t.to]);
        await DB.put("transactions", t);
        closeAll(); render(); scheduleSync(); toast("Операция изменена");
      };
    });
  }

  // ---------- список операций по объекту (категория / счёт) ----------
  const txMonth = (t) => (t.ts || "").slice(0, 7);
  function showOperations(kind, name) {
    let items, emoji, subtitle, total, totalColor, addLabel = null;
    if (kind === "category") {
      const c = catByName(name);
      items = state.transactions.filter((t) => t.type === "expense" && t.cat === name && txMonth(t) === MONTH);
      emoji = c ? c.emoji : "🪙";
      subtitle = "Расходы · " + monthTitle();
      total = spentOf(name);
      totalColor = total > 0 ? "var(--red)" : "var(--muted)";
      addLabel = "＋ Добавить расход";
    } else {
      const a = accByName(name);
      items = state.transactions.filter((t) => (t.acc === name || t.to === name) && txMonth(t) === MONTH);
      emoji = a ? curSym(a.currency) : "•";
      subtitle = "Обороты · " + monthTitle();
      let net = 0;
      for (const t of items) net += (t.acc === name ? t.amount : -t.amount);
      total = net;
      totalColor = net < 0 ? "var(--red)" : net > 0 ? "var(--coin-green)" : "var(--muted)";
    }
    items.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    const totalStr = (kind === "category")
      ? f0(total) + " ₴"
      : (total > 0 ? "+" : total < 0 ? "−" : "") + f0(Math.abs(total)) + (accByName(name) ? " " + curSym(accByName(name).currency) : "");

    openEditor(`
      <div class="form">
        <div class="sheet-head" style="margin-bottom:12px">
          <div class="em" style="background:var(--surface-2)">${esc(emoji)}</div>
          <div><div class="t" style="font-weight:800;color:var(--ink);font-size:15px">${esc(name)}</div><div class="t">${subtitle}</div></div>
          <div class="amt" style="font-size:22px;color:${totalColor}">${totalStr}</div>
        </div>
        ${addLabel ? `<button class="save" id="opAdd" style="margin-top:0;margin-bottom:12px">${addLabel}</button>` : ""}
        <div class="recent" id="opList"></div>
        <div class="form-actions"><button class="btn ghost" id="eCancel">Закрыть</button></div>
      </div>`, () => {
      $("eCancel").onclick = closeAll;
      const add = $("opAdd");
      if (add) add.onclick = () => openSheet("expense", name);
      const list = $("opList");
      if (!items.length) list.innerHTML = `<div class="rrow"><span class="s">Нет операций за этот месяц</span></div>`;
      else for (const t of items) list.appendChild(opRow(t, true));
    });
  }

  // ---------- меню ----------
  const menu = $("menu");
  $("menuBtn").onclick = (e) => { e.stopPropagation(); updateDriveMenu(); menu.classList.toggle("on"); };
  document.body.addEventListener("click", () => menu.classList.remove("on"));
  menu.querySelectorAll("button").forEach((b) => b.onclick = async () => {
    const act = b.dataset.act;
    if (act === "gdrive") connectDrive();
    else if (act === "gdriveOff") disconnectDrive();
    else if (act === "incomes") manageIncomes();
    else if (act === "plan") editPlan();
    else if (act === "theme") {
      const r = document.documentElement, cur = r.getAttribute("data-theme");
      const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme:dark)").matches;
      const next = dark ? "light" : "dark"; r.setAttribute("data-theme", next); await setMeta("theme", next);
    } else if (act === "export") {
      await doExport();
    } else if (act === "import") {
      doImport();
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

  // ---------- синхронизация с Google Drive (автосинк) ----------
  // IndexedDB — источник истины; здесь только push снапшота в привязанный файл vault.
  // Дебаунс после изменений + флаш по online / возврату вкладки. Офлайн не блокируем —
  // операции копятся (synced:false), доливаются при появлении сети/фокуса.
  let syncTimer = null;      // таймер дебаунса
  let syncSuspended = true;  // true во время boot/import — не дёргать синк
  let syncState = "idle";    // "idle" | "syncing" | "error" (транзиентно, для индикатора)
  let driveDirty = false;    // снапшот изменился с последней успешной заливки
  const SYNC_DEBOUNCE = 3500;

  function friendly(e) {
    const m = (e && e.message) || String(e);
    if (/cancelled/i.test(m)) return "отменено";
    if (/access_denied|popup|interaction_required|consent|login_required/i.test(m)) return "нужно переподключить Google";
    return m;
  }

  // Запланировать отложенную заливку после изменения данных (дебаунс).
  function scheduleSync() {
    if (syncSuspended || !GDrive.isConnected()) return;
    driveDirty = true;
    renderSync();
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => flushToDrive(false), SYNC_DEBOUNCE);
  }

  // Залить снапшот в Drive. manual=true — ручной «Синк сейчас» (тосты/принудительно).
  async function flushToDrive(manual) {
    if (!GDrive.isConnected()) { if (manual) toast("Google Drive не подключён"); return false; }
    if (!navigator.onLine) { if (manual) toast("Нет сети — синхронизирую позже"); renderSync(); return false; }
    if (!manual && !driveDirty && unsyncedCount() === 0) return false;
    clearTimeout(syncTimer);
    syncState = "syncing"; renderSync();
    try {
      await GDrive.push(Vault.buildJSON(state));
      // Снапшот целиком ушёл в vault — помечаем операции синхронизированными.
      const unsynced = state.transactions.filter((t) => !t.synced);
      for (const t of unsynced) { t.synced = true; await DB.put("transactions", t); }
      driveDirty = false; syncState = "idle"; renderSync();
      if (manual) toast("Синхронизировано с Google Drive");
      return true;
    } catch (e) {
      console.error(e); syncState = "error"; renderSync();
      toast("Синк не удался: " + friendly(e)); // данные не теряем — попробуем позже
      return false;
    }
  }

  // Индикатор синка: синхронизировано / N не синхр. / офлайн / без Drive / синк… / ошибка.
  function renderSync() {
    const el = $("sync"), txt = $("syncTxt");
    if (!el || !txt) return;
    const n = unsyncedCount();
    el.className = "sync";
    if (syncState === "syncing") { el.classList.add("syncing"); txt.textContent = "синк…"; return; }
    if (syncState === "error") { el.classList.add("error"); txt.textContent = n > 0 ? (n + " не синхр.") : "ошибка синка"; return; }
    if (!navigator.onLine) { el.classList.add("offline"); txt.textContent = n > 0 ? (n + " офлайн") : "офлайн"; return; }
    if (GDrive.isConfigured() && !GDrive.isConnected()) {
      el.classList.add(n > 0 ? "pending" : "nolink");
      txt.textContent = n > 0 ? (n + " не синхр.") : "без Drive";
      return;
    }
    if (n > 0) { el.classList.add("pending"); txt.textContent = n + " не синхр."; return; }
    el.classList.add("ok"); txt.textContent = "синхр.";
  }

  // Пункт меню «Подключить Google Drive»: консент + выбор файла/папки, затем первая заливка.
  async function connectDrive() {
    if (!GDrive.isConfigured()) { toast("Нет ключей Google — добавь config.local.js"); return; }
    try {
      toast("Открываю Google…");
      await GDrive.connect();
      updateDriveMenu(); renderSync();
      toast("Google Drive подключён");
      await flushToDrive(true); // первичная заливка текущего снапшота
    } catch (e) {
      if (e && e.message === "cancelled") return;
      console.error(e); toast("Не удалось подключить: " + friendly(e));
    }
  }

  async function disconnectDrive() {
    await GDrive.disconnect();
    updateDriveMenu(); renderSync();
    toast("Google Drive отключён");
  }

  // Показ/подписи пунктов меню Drive по состоянию подключения.
  function updateDriveMenu() {
    const m = $("menu"); if (!m) return;
    const on = m.querySelector('[data-act="gdrive"]');
    const off = m.querySelector('[data-act="gdriveOff"]');
    const configured = GDrive.isConfigured(), connected = GDrive.isConnected();
    if (on) { on.hidden = !configured; on.textContent = connected ? "Переподключить Google Drive" : "Подключить Google Drive"; }
    if (off) off.hidden = !connected;
  }

  // ---------- экспорт в vault (§4, §6) ----------
  async function doExport() {
    try {
      const res = await Vault.exportVault(state);
      // Полный снапшот ушёл в vault — помечаем все операции синхронизированными.
      const unsynced = state.transactions.filter((t) => !t.synced);
      for (const t of unsynced) { t.synced = true; await DB.put("transactions", t); }
      render();
      toast(res.mode === "dir" ? "Экспортировано в папку vault (Финансы — Монетки.json)"
        : res.mode === "download" ? "Файл .json сохранён — FolderSync донесёт в vault"
        : res.mode === "picked" ? "Экспортировано, файл .json привязан для перезаписи"
        : "Экспортировано в vault");
    } catch (e) {
      if (e && e.name === "AbortError") return; // пользователь закрыл выбор файла
      console.error(e); toast("Не удалось экспортировать: " + ((e && e.message) || e));
    }
  }

  // ---------- импорт/восстановление из vault (§4) ----------
  // Импорт «всего сразу» из единого файла «Финансы — Монетки.json»:
  //   • десктоп (showDirectoryPicker) — выбираем ПАПКУ vault, читаем файл(ы) за раз
  //     (JSON приоритетнее; старый .md ещё поддержан ради миграции);
  //   • телефон — выбор файла; мобильный экспорт и так один совмещённый JSON.
  // Импорт ЗАМЕНЯЕТ данные приложения целиком.
  async function doImport() {
    try {
      if (typeof window.showDirectoryPicker === "function") {
        let dir;
        try { dir = await window.showDirectoryPicker({ mode: "read" }); }
        catch (e) { if (e && e.name === "AbortError") return; throw e; }
        const { data, files, format } = await Vault.importFromDir(dir);
        await applyImport(data, `папки (${files} файл., ${format || "—"})`);
        return;
      }
      // фолбэк — выбор файла(ов); .json (основной) или legacy .md
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = ".json,.md,application/json,text/markdown,text/plain"; inp.multiple = true;
      inp.onchange = async () => {
        const files = Array.from(inp.files || []);
        if (!files.length) return;
        const texts = await Promise.all(files.map((f) => f.text()));
        await applyImport(mergeParsed(texts.map((t) => Vault.parseAny(t))), `${files.length} файл.`);
      };
      inp.click();
    } catch (e) { console.error(e); toast("Ошибка импорта: " + ((e && e.message) || e)); }
  }

  // Слить несколько разобранных снапшотов: счета/категории по имени, операции по
  // id (иначе по контент-ключу), план — первый ненулевой.
  function mergeParsed(list) {
    const accounts = [], categories = [], transactions = [];
    const accSeen = new Set(), catSeen = new Set(), txSeen = new Set();
    let plan = null;
    for (const d of list) {
      if (plan == null && d.plan != null) plan = d.plan;
      for (const a of d.accounts || []) if (!accSeen.has(a.name)) { accSeen.add(a.name); accounts.push(a); }
      for (const c of d.categories || []) if (!catSeen.has(c.name)) { catSeen.add(c.name); categories.push(c); }
      for (const t of d.transactions || []) {
        const key = t.id || [t.ts, t.amount, t.cat, t.acc, t.to || "", t.type].join("|");
        if (!txSeen.has(key)) { txSeen.add(key); transactions.push(t); }
      }
    }
    return { accounts, categories, transactions, plan };
  }

  async function applyImport(data, sourceLabel) {
    const n = data.transactions.length, m = data.accounts.length, k = data.categories.length;
    if (!n && !m && !k) { toast("Не найдено данных Монеток"); return; }
    if (!confirm(`Импорт из ${sourceLabel}:\nопераций ${n}, счетов ${m}, категорий ${k}.\nТекущие данные будут заменены.`)) return;
    await DB.clear("transactions"); await DB.clear("accounts"); await DB.clear("categories");
    if (k) await DB.bulkPut("categories", data.categories);
    if (m) await DB.bulkPut("accounts", data.accounts);
    if (n) await DB.bulkPut("transactions", data.transactions);
    if (data.plan != null) await setMeta("plan", data.plan);
    await boot(true);
    toast(`Импортировано: ${n} операций, ${m} счетов, ${k} категорий`);
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
    syncSuspended = true; // не дёргать синк, пока грузимся/импортируемся
    await DB.ensureSeeded();
    await GDrive.load(); // восстановить привязку к файлу Drive (fileId в meta)
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
    updateDriveMenu();
    syncSuspended = false; // готовы — можно синкать
    // Догоняющая заливка: если подключён Drive и есть несинхронизированное с прошлой
    // (возможно, офлайн) сессии — дольём в фоне. flushToDrive сам проверит сеть/очередь.
    if (GDrive.isConnected()) flushToDrive(false);
    // Автопредложение импорта при пустой базе убрано: надоедало при каждом
    // холодном старте PWA. Восстановление — вручную через меню «Импорт из vault».
    if (!reload) refreshRates(false);
  }

  function start() {
    boot(false).catch((e) => { console.error(e); toast("Ошибка загрузки данных"); });
    // Service Worker — офлайн-оболочка (§7). Работает только по http(s).
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
    }
    window.addEventListener("online", () => { refreshRates(true); renderSync(); flushToDrive(false); });
    window.addEventListener("offline", () => renderSync());
    // Возврат вкладки в фокус — хороший момент долить накопившееся.
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushToDrive(false); });
  }

  return { start, _state: state };
})();

App.start();
