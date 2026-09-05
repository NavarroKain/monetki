"use strict";
/* Слой данных: IndexedDB — каноничный источник истины (§4, §6).
   Все чтения/записи идут сюда, мгновенно, офлайн. Тонкая промис-обёртка без зависимостей.
   Хранилища:
     accounts     — счета и источники доходов (kind:"income"); keyPath id
     categories   — категории трат; keyPath id
     transactions — операции; keyPath id
     meta         — настройки (план, курсы, тема, версия сида); keyPath key
*/

const DB = (function () {
  const NAME = "monetki";
  const VER = 1;
  let _p = null;

  function open() {
    if (_p) return _p;
    _p = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VER);
      r.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("accounts")) db.createObjectStore("accounts", { keyPath: "id" });
        if (!db.objectStoreNames.contains("categories")) db.createObjectStore("categories", { keyPath: "id" });
        if (!db.objectStoreNames.contains("transactions")) db.createObjectStore("transactions", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return _p;
  }

  function tx(store, mode, fn) {
    return open().then((db) => new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then((v) => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  }

  const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  return {
    open,
    getAll: (store) => tx(store, "readonly", (s) => reqP(s.getAll())),
    get: (store, key) => tx(store, "readonly", (s) => reqP(s.get(key))),
    put: (store, val) => tx(store, "readwrite", (s) => reqP(s.put(val))),
    del: (store, key) => tx(store, "readwrite", (s) => reqP(s.delete(key))),
    clear: (store) => tx(store, "readwrite", (s) => reqP(s.clear())),
    bulkPut: (store, arr) => tx(store, "readwrite", (s) => { arr.forEach((v) => s.put(v)); return arr.length; }),

    // Первичное заполнение из seed.js (§5). Идемпотентно по версии сида в meta.
    async ensureSeeded() {
      const marker = await this.get("meta", "seededVersion").catch(() => null);
      if (marker && marker.value >= window.SEED_VERSION) return false;

      const uid = () => (crypto.randomUUID ? crypto.randomUUID()
        : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));

      const cats = window.SEED.cats.map((c, i) => ({
        id: uid(), name: c.name, limit: c.limit, emoji: c.emoji, group: c.group || null,
        archived: false, order: i,
      }));
      const accs = window.SEED.accounts.map((a, i) => ({
        id: uid(), name: a.name, balance: a.balance, currency: a.currency, kind: a.kind,
        plan: null, archived: false, order: i,
      }));
      const incs = window.SEED.incomes.map((a, i) => ({
        id: uid(), name: a.name, balance: 0, currency: "UAH", kind: "income",
        plan: a.plan || null, archived: false, order: 100 + i,
      }));
      // Операции стартуют пустыми: по §5 сид — это счета/категории/доходы.
      // Демо-траты прототипа в реальный ledger не заносим (иначе фиктивные строки и
      // рассинхрон с уже реальными балансами счетов).
      await this.bulkPut("categories", cats);
      await this.bulkPut("accounts", accs.concat(incs));
      await this.put("meta", { key: "plan", value: window.SEED.plan });
      await this.put("meta", { key: "rates", value: window.SEED.rates });
      await this.put("meta", { key: "seededVersion", value: window.SEED_VERSION });
      return true;
    },

    // Полный сброс к сид-состоянию (пункт меню «Сбросить все данные»).
    async resetAll() {
      await this.clear("categories");
      await this.clear("accounts");
      await this.clear("transactions");
      await this.clear("meta");
      await this.ensureSeeded();
    },
  };
})();

window.DB = DB;
