# Nexus IoT Platform — Frontend (no backend yet)

React + TypeScript + Vite. The backend is not implemented — every network
call goes through `src/api/mockApi.ts`, which keeps state in memory and
simulates latency, so the whole UI works standalone.

## Run

```sh
npm install
npm run dev       # http://localhost:5173, login with admin / admin
npm run build     # production build -> dist/
```

Verified: `tsc -b` type-checks clean, `npm run build` completes clean.
Full in-browser runtime testing wasn't possible in this environment (no
network access to download a browser binary) — test the dev server in an
actual browser before relying on it.

## How this maps to the brief

| Требование | Реализация |
|---|---|
| Логин admin/admin + SVG-лого | `pages/LoginPage.tsx`. Загруженный SVG прогоняется через `DOMPurify` перед рендером (`dangerouslySetInnerHTML` на несанитизированном SVG — классический XSS) |
| Принудительная смена пароля | `components/ChangePasswordGate.tsx`, оборачивает весь защищённый layout |
| 3 вкладки слева | `components/Layout.tsx` + `react-router-dom` |
| Устройство: только предоставленный SVG | `components/DeviceDiagram.tsx` рендерит `src/assets/Web_GUI.svg` **дословно** (через Vite `?raw` импорт, без единой сгенерированной фигуры). Состояние применяется через `element.style.fill` поверх уже существующих в файле слоёв заливка+контур — ровно та же техника, что проверялась попиксельным сравнением в прошлой версии. Порты: `power, ethernet1, ethernet2, usb, audioIn, audioOut, sdcard, lcd, modules` (имена id в самом SVG) |
| ПКМ по модулю → настройка (RS485: скорость/чётность/бит/стоп-бит/путь/протокол) | `components/ModuleConfigModal.tsx` |
| Сценарий: React Flow, if/else, while, RS485 receive/parse/send, реле | `pages/ScenarioPage.tsx` + `scenario/` |
| Переменные вида `RS485-1.1` | текстовое поле в конфиге узла (валидация формата — TODO на бэкенде) |
| Таблица регистров (байт/имя/тип/описание) | редактор таблицы внутри `rs485_parse` узла и в модалке модуля |
| Подсказки на каждом блоке | `title` атрибут (`def.tooltip` в `nodeDefs.ts`) на каждом узле и в палитре |
| Мониторинг: Linux/RAM/CPU | `pages/MonitoringPage.tsx` |
| Синий системный фон | `styles/theme.css`, `--brand: #0B3D91` — **плейсхолдер**, поменяйте одну переменную, когда пришлёте точный HEX/брендбук |

## Запуск на устройстве (OpenWrt, AM3352)

Node на устройстве **не нужен**: интерфейс — это статические файлы (`dist/`),
их раздаёт штатный `uhttpd`. Вся работа интерфейса идёт в браузере ПК,
нагрузка на устройство ничтожна.

```sh
# 1) на ПК (нужен Node 18+)
npm install
./deploy/pack.sh                       # -> deploy/nexus-iot-openwrt.tar.gz

# 2) отправить на устройство (если scp ругается — добавьте ключ -O)
scp -O deploy/nexus-iot-openwrt.tar.gz root@<ip-устройства>:/tmp/

# 3) на устройстве
cd /tmp && tar -xzf nexus-iot-openwrt.tar.gz && cd nexus-iot-openwrt
sh install.sh            # порт 8080; другой порт: sh install.sh 8081

# 4) в браузере ПК из той же сети
http://<ip-устройства>:8080/
```

- Скрипт создаёт **отдельный** экземпляр `uhttpd` (секция `uhttpd.nexus` в UCI),
  страница LuCI на порту 80 не затрагивается. Автозапуск при загрузке включён.
- Обновление: снова `pack.sh` → копия → `sh install.sh` (старая сборка заменяется).
- Удаление: `sh install.sh --remove`.
- Нужен пакет `uhttpd` (`opkg install uhttpd` или `apk add uhttpd`).
- Адреса вкладок имеют вид `/#/monitoring` (HashRouter): обновление страницы
  никогда не даёт 404, настраивать rewrite на сервере не нужно.
- Папка `www` можно положить и в `/www/nexus/` — откроется как `http://<ip>/nexus/`
  (сборка использует относительные пути, `base: './'`).
- Если с ПК не открывается: проверьте, что ПК и устройство в одной сети и что
  порт разрешён в зоне LAN файрвола (`/etc/config/firewall`).

Пока бэкенда нет, сценарий хранится в `localStorage` браузера: он привязан к
браузеру и адресу (`ip:порт`). С другого ПК или по другому адресу он будет пустым.
Вход отключён (`AUTO_LOGIN_TOKEN` в `store/authStore.ts`) — до появления
реального API любой в сети увидит интерфейс; включите авторизацию вместе с бэкендом.

## Monitoring charts

`pages/MonitoringPage.tsx` shows CPU % and RAM MB against time as two separate
single-series charts (`components/TimeSeriesChart.tsx`, plain SVG, no chart
dependency): hover/arrow-key crosshair with a tooltip, a "Таблица" view for the
same values, and a 1/5/15 minute range filter above both. History is kept in
`store/metricsStore.ts` (300 samples at 3 s), started from `Layout`, so it keeps
accumulating while another tab is open. Line colors `#3987e5` / `#d95926` were
checked against the app surface `#0f296b` with the data-viz palette validator.
Backend contract: `SystemInfo.sampledAt` (epoch ms) on every sample and a
history call `fetchSystemHistory(minutes, stepSec)`.

## Scenario editor

Block icons are original line icons in `scenario/NodeIcons.tsx`. The connection
delete button (×) appears only while the pointer is over a connection (or it is
selected) — `scenario/DeletableEdge.tsx`.

## Contract with the future backend

`src/api/types.ts` is the single source of truth for request/response
shapes. `src/api/mockApi.ts` implements every function with that exact
signature, using `setTimeout` for latency and an in-memory `Map` for state,
plus a `subscribeLive()` function that stands in for a future
`WebSocket`. When the real Go backend is ready:

1. Replace each function body in `mockApi.ts` with a `fetch('/api/...')` call
   (same signature, so no component changes).
2. Replace `subscribeLive` with a real `WebSocket` client that dispatches the
   same `LiveEvent` union.

No component imports `mockApi` functions by implementation — they only rely
on the types in `types.ts`, so this swap is intentionally mechanical.

## Scenario tab: autosave + deletable edges

- **No Save button.** Every change to nodes/edges is debounced (500ms) and
  written to `localStorage` under the key `plc_scenario_default_v1`, plus
  mirrored into the mock API. This code never calls `localStorage.removeItem`
  or `.clear()` on that key — the graph survives page reloads and browser
  restarts, and is only lost if the person clears site data themselves.
- **Deleting a connection:** hover an edge to reveal a small `×` button at
  its midpoint (`scenario/DeletableEdge.tsx`), or select an edge/node and
  press Backspace/Delete.

## Known placeholders / assumptions to confirm

- **Device diagram artwork** — now exactly your `Web_GUI.svg`, nothing else.
- **Brand color** — `#0B3D91`, pending your exact HEX.
- **Module/scenario node field lists** — my best guess at what each
  configuration needs; adjust `scenario/nodeDefs.ts` and
  `components/ModuleConfigModal.tsx` field arrays to match your real
  requirements.
- **Graph → executable code compilation** — out of scope for this frontend
  pass; `startScenario()`/`stopScenario()` are stubs. This needs a real
  design decision on the backend (see architecture discussion: bytecode +
  interpreter recommended over transpiling to Lua/Go).
