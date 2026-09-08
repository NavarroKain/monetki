# Настройка синхронизации через Google Drive

Одноразовая настройка (~15 минут). После неё приложение само пишет снапшот
`Финансы — Монетки.json` прямо в папку vault в Google Drive — без FolderSync и без
ручного экспорта. IndexedDB остаётся источником истины, синк отложенный.

Клиент-секрет не нужен: используется браузерный token-флоу Google Identity Services
со scope `drive.file` (доступ только к файлам, которые приложение создало или которые
ты сам выбрал через Picker — не ко всему Drive). Верификация приложения в Google для
личного использования не требуется.

## 1. Проект в Google Cloud Console

1. Открой [Google Cloud Console](https://console.cloud.google.com/) → создай новый проект
   (или используй существующий).
2. **APIs & Services → Library** → включи:
   - **Google Drive API**
   - **Google Picker API**

## 2. OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. User type: **External** → Create.
3. Заполни обязательное (название приложения, свой email). Логотип/домены не нужны.
4. Режим публикации оставь **Testing**.
5. **Test users** → добавь свой Gmail. В режиме Testing доступ есть только у тест-юзеров —
   этого достаточно, верификация не нужна.
6. Scopes можно не добавлять вручную — `drive.file` запросится при первом входе.

## 3. Credentials

### OAuth client ID (для входа)
1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. **Authorized JavaScript origins** — добавь ровно те origin, откуда открываешь приложение
   (без пути, только схема+хост+порт):
   - `https://<username>.github.io` — GitHub Pages (прод на телефоне);
   - `http://localhost:8080` (или твой порт) — для локальной разработки.

   > Origin должен совпадать **точно**. `https://user.github.io` и
   > `https://user.github.io/monetki` — это один origin `https://user.github.io`
   > (путь в origin не входит). Порт для localhost обязан совпадать.
4. Скопируй **Client ID**.

### API key (для Picker)
1. **Create Credentials → API key**.
2. Скопируй ключ. (По желанию: Restrict key → Application restrictions: HTTP referrers,
   Website restrictions — твои origin; API restrictions — Google Picker API.)

## 4. Ключи в `config.local.js`

В корне приложения скопируй шаблон и впиши свои ключи:

```bash
cp config.local.example.js config.local.js
```

```js
window.GDRIVE_CONFIG = {
  clientId: "ВАШ_CLIENT_ID.apps.googleusercontent.com",
  apiKey:   "ВАШ_API_KEY",
  scope:    "https://www.googleapis.com/auth/drive.file",
  fileName: "Финансы — Монетки.json", // НЕ менять — файл читает Аналитика.md
};
```

`config.local.js` — в `.gitignore`, в репозиторий не попадает. Клиент-секрет сюда **не**
клади (в браузерном флоу он не используется).

## 5. Развёртывание с ключами (важно для GitHub Pages)

`config.local.js` не коммитится, поэтому на GitHub Pages его по умолчанию **не будет** —
и Drive-синк будет выключен (приложение при этом работает, индикатор покажет «без Drive»).
Чтобы ключи попали на прод, выбери один вариант:

- **Приватная ветка/репозиторий для Pages.** Публикуй Pages из ветки, куда `config.local.js`
  добавлен (сними его из `.gitignore` только в этой приватной ветке). Ключи `drive.file`
  «полусекретны» (ограничены твоими origin и тест-юзерами), но не выставляй их в публичном репо.
- **GitHub Actions.** В workflow деплоя запиши `config.local.js` из GitHub Secrets перед
  публикацией:
  ```yaml
  - run: |
      cat > config.local.js <<'EOF'
      window.GDRIVE_CONFIG = { clientId: "${{ secrets.GDRIVE_CLIENT_ID }}",
        apiKey: "${{ secrets.GDRIVE_API_KEY }}",
        scope: "https://www.googleapis.com/auth/drive.file",
        fileName: "Финансы — Монетки.json" };
      EOF
  ```
- Локально/на своём хостинге просто положи `config.local.js` рядом с `index.html`.

## 6. Первое подключение в приложении

1. Открой приложение со своего origin (того, что в Authorized origins).
2. Меню (⋯) → **Подключить Google Drive**.
3. Пройди консент Google (один раз).
4. В **Google Picker** выбери существующий файл `Финансы — Монетки.json` в папке vault.
   Если файла ещё нет — выбери **папку vault**, приложение само создаст файл в ней.
5. Готово: `fileId` сохранён. Дальше приложение обновляет **этот же файл** на месте —
   после каждой операции (дебаунс ~3.5 c), при возврате в сеть и при возврате вкладки в фокус.

Индикатор синка вверху: `синхр.` / `N не синхр.` / `офлайн` / `без Drive` / `синк…`. Клик по
нему — ручная синхронизация «сейчас».

## Проверка приёмки

- После ввода операции (онлайн) файл в папке vault обновляется в течение ~5 c, без второго файла.
- Офлайн: операции копятся и доливаются сами при возврате сети.
- Аналитика в Obsidian продолжает читать тот же `Финансы — Монетки.json`.

## Если что-то не так

- **`origin_mismatch` / `idpiframe_initialization_failed`** — origin приложения не совпадает
  с Authorized JavaScript origins. Проверь схему/хост/порт.
- **Окно консента не открылось / `access_denied`** — твой email не в Test users, либо
  приложение не в режиме Testing.
- **Picker пустой или ошибка ключа** — не включён Google Picker API или неверный `apiKey`.
- **«без Drive» на проде** — `config.local.js` не попал в развёртывание (см. п. 5).
