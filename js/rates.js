"use strict";
/* Курсы валют → гривна (§5a).
   Живой рыночный курс из публичного API Monobank (без ключа). Кэш в meta.rates.
   Оффлайн / ошибка / CORS — используем последний кэш, ввод никогда не блокируется.
   Прокси курса через прослойку (Phase 2) подключается сюда же как второй источник. */

const Rates = (function () {
  const URL_DIRECT = "https://api.monobank.ua/bank/currency";
  const ISO = { 980: "UAH", 840: "USD", 978: "EUR" };
  const MIN_REFRESH_MS = 6 * 60 * 1000; // Monobank отдаёт ~раз в 5 мин; не чаще (§5a).

  // Прокси-эндпоинт прослойки для обхода CORS (задаётся в Phase 2 через config).
  let proxyUrl = null;
  function setProxy(url) { proxyUrl = url || null; }

  function parse(list) {
    // Возвращает { USD: rate, EUR: rate, ... } — цена 1 ед. валюты в UAH.
    const out = { UAH: 1 };
    for (const p of list || []) {
      const a = ISO[p.currencyCodeA], b = ISO[p.currencyCodeB];
      if (!a || b !== "UAH") continue; // нужны пары «валюта → UAH»
      let rate = null;
      if (typeof p.rateCross === "number" && p.rateCross > 0) rate = p.rateCross;
      else if (p.rateBuy > 0 && p.rateSell > 0) rate = (p.rateBuy + p.rateSell) / 2;
      else if (p.rateSell > 0) rate = p.rateSell;
      else if (p.rateBuy > 0) rate = p.rateBuy;
      if (rate) out[a] = rate;
    }
    return out;
  }

  async function fetchFrom(url) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return parse(await r.json());
    } finally {
      clearTimeout(to);
    }
  }

  // Тянет свежий курс при необходимости; сохраняет в meta.rates; возвращает актуальный объект.
  async function refresh(cached, force) {
    const now = Date.now();
    if (!force && cached && cached.ts && (now - cached.ts) < MIN_REFRESH_MS) {
      return cached; // свежий кэш — не дёргаем сеть лишний раз
    }
    if (!navigator.onLine) return cached;

    let fresh = null;
    try { fresh = await fetchFrom(URL_DIRECT); }
    catch (e) {
      if (proxyUrl) { try { fresh = await fetchFrom(proxyUrl); } catch (e2) { fresh = null; } }
    }
    if (!fresh || !fresh.USD) return cached; // ничего не вышло — остаёмся на кэше

    const merged = Object.assign({ UAH: 1 }, cached && cached.base ? {} : cached, fresh);
    merged.ts = now;
    merged.base = false;
    return merged;
  }

  // «курс на 05.09, 14:20» либо «базовый курс», если живого ещё не было.
  function label(rates) {
    if (!rates || !rates.ts) return "базовый курс";
    const d = new Date(rates.ts);
    const p = (n) => String(n).padStart(2, "0");
    return `курс ${p(d.getDate())}.${p(d.getMonth() + 1)}, ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  return { refresh, label, setProxy };
})();

window.Rates = Rates;
