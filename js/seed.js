"use strict";
/* Начальные данные (seed) из брифа §5. Реальные счета/категории заказчика.
   Загружаются один раз при первом запуске; дальше источник истины — IndexedDB. */

// Версия сида. Поднять, если нужно принудительно пересеять чистую базу.
window.SEED_VERSION = 1;

window.SEED = {
  // План месяца (плановые траты). Пусто в шаблоне — задаётся на устройстве (§5).
  plan: 0,

  // Дефолтные курсы к гривне до первого успешного запроса к Monobank (§5a).
  // Живой рыночный курс перезапишет их; при офлайне используется последний кэш.
  rates: { UAH: 1, USD: 41.5, EUR: 45, ts: null, base: true },

  // Категории трат: имя · лимит/мес (null = без лимита, зелёная) · эмодзи.
  cats: [
    { name: "Продукты",        limit: 5000, emoji: "🛒" },
    { name: "Еда вне дома",     limit: 9000, emoji: "🍔" },
    { name: "Транспорт",        limit: null, emoji: "🚌" },
    { name: "Покупки",          limit: 5000, emoji: "🛍️" },
    { name: "Дом. хоз-во",      limit: 5000, emoji: "🏠" },
    { name: "Развлечения",      limit: null, emoji: "🎬" },
    { name: "Услуги",           limit: 500,  emoji: "🧰" },
    { name: "Подарки",          limit: 750,  emoji: "🎁" },
    { name: "Лекарства",        limit: 400,  emoji: "💊" },
    { name: "Тренажёрный зал",   limit: null, emoji: "🏋️" },
    { name: "Коммуналка",       limit: 2500, emoji: "🧾" },
    { name: "Предприятие",      limit: null, emoji: "🏢" },
    { name: "Одежда",           limit: 400,  emoji: "🧥" },
    { name: "Комиссия",         limit: null, emoji: "💱" },
    { name: "Инвестиции",       limit: 3000, emoji: "🪙" },
    { name: "ФОП налоги",       limit: 4000, emoji: "📊" },
  ],

  // Счета — НЕЙТРАЛЬНЫЙ ШАБЛОН. Никаких личных данных в репозитории (§8, приватность):
  // ни реальных названий счетов/банков, ни балансов. Реальные счета и суммы заводятся
  // на устройстве (＋ и режим «Баланс»); данные живут только в IndexedDB/vault.
  accounts: [
    { name: "Наличные",     balance: 0, currency: "UAH", kind: "cash" },
    { name: "Карта",        balance: 0, currency: "UAH", kind: "card" },
    { name: "Депозит",      balance: 0, currency: "UAH", kind: "deposit" },
    { name: "ФОП",          balance: 0, currency: "UAH", kind: "fop" },
    { name: "USD наличные", balance: 0, currency: "USD", kind: "cash" },
    { name: "USD карта",    balance: 0, currency: "USD", kind: "card" },
    { name: "EUR наличные", balance: 0, currency: "EUR", kind: "cash" },
    { name: "EUR карта",    balance: 0, currency: "EUR", kind: "card" },
  ],

  // Источники доходов (kind: income). Нейтральный шаблон — реальные источники и планы
  // заводятся на устройстве (§5b), в репозитории личных данных нет.
  incomes: [
    { name: "Доход", plan: null },
  ],

  // Операций в шаблоне нет — ledger стартует пустым (реальные данные только на устройстве).
  tx: [],
};
