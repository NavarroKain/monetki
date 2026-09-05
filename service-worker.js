"use strict";
/* Service Worker для «Монеток».
   Прекеширует оболочку приложения → открывается офлайн, в т.ч. с домашнего экрана (§7).
   Стратегия:
     - навигации (HTML): network-first с фолбэком в кэш → свежий код при сети, оффлайн — из кэша;
     - остальная статика оболочки (CSS/JS/иконки/манифест): cache-first;
     - сторонние запросы (курсы Monobank, шрифты): не перехватываем, идут в сеть.
   Данные операций живут в IndexedDB, не тут. */

const CACHE = "monetki-shell-v2";

// Относительные пути — чтобы работало и в корне, и в подпапке GitHub Pages.
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/seed.js",
  "./js/db.js",
  "./js/rates.js",
  "./js/vault.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Только свой origin. Курсы валют и шрифты — мимо, пусть решает сеть/приложение.
  if (url.origin !== self.location.origin) return;

  // Навигация → network-first (свежий HTML), офлайн — кэш.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // Прочая статика оболочки → cache-first, добираем из сети и докешируем.
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});

// Позволяет странице попросить немедленно активировать новый SW.
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});
