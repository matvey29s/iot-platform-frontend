# Nexus IoT Platform — Frontend (no backend yet)

React + TypeScript + Vite. The backend is not implemented — every network
call goes through `src/api/mockApi.ts`, which keeps state in memory and
simulates latency, so the whole UI works standalone.

## Run

```sh
npm install
npm run dev:mock  # http://localhost:5173 with an in-memory mock, no controller needed
NEXUS_BACKEND=http://<device-ip>:8080 npm run dev   # UI in dev mode, real data from the device
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

## Архитектура и запуск на устройстве (OpenWrt, AM3352)

```
АЦП (IIO sysfs) ─► nexusd (C) ──unix-сокет, JSON-строки──► nexus-backend (Go) ──REST + SSE──► браузер
                     │  хук module-hook.sh: пины UART / GPIO       │  статика UI, настройки, сценарии
                     └─ метрики Linux (/proc)                      └─ сост. Ethernet / USB / SD
```

- **`daemon/nexusd.c`** (чистый C, без зависимостей) — всё железо. Каждые 3 с читает АЦП: канал 0 —
  модуль 1, канал 1 — модуль 2. ≈16,4% от максимума (±5) — RS-485, ≈91,6% (±5) — реле, иначе слот пуст.
  Тип должен совпасть `confirm=2` раза подряд, затем хук `/etc/nexus/hooks/module-hook.sh <слот> uart|gpio|none`
  переключает мультиплексор пинов. Дальше daemon сам работает с модулем: RS-485 — открывает UART,
  принимает/передаёт кадры, управляет линиями DE и /RE; реле — 4 GPIO-канала. Кроме того: 3 программируемые
  кнопки (GPIO66/69/45, антидребезг 30 мс), 3 светодиода (GPIO49/112/20), метрики CPU/RAM/диск/uptime.
- **`backend/`** (Go, только стандартная библиотека). Подключается к сокету daemon, отдаёт UI и API,
  **выполняет сценарии** (`engine.go`), ведёт журнал терминала RS-485, хранит настройки модулей, таблицы
  регистров, сценарии и время последнего нажатия кнопок в `/opt/nexus-iot/data/state.json`. Запущенный
  сценарий возобновляется после перезагрузки. Живые события — Server-Sent Events (`/api/events`).
- **Frontend** ходит в `api/...` (`src/api/realApi.ts`). Без контроллера: `npm run dev:mock`.

```sh
# 1) на ПК (Node 18+, Go 1.22+, pip install ziglang — кросс-компилятор C для ARMv7)
npm install
./deploy/pack.sh                       # -> deploy/nexus-iot-openwrt.tar.gz

# 2) на устройство (если scp ругается — ключ -O)
scp -O deploy/nexus-iot-openwrt.tar.gz root@<ip>:/tmp/

# 3) на устройстве
cd /tmp && tar -xzf nexus-iot-openwrt.tar.gz && cd nexus-iot-openwrt
sh install.sh                          # порт 8080; другой: sh install.sh 8081

# 4) браузер ПК из той же сети:  http://<ip>:8080/
```

- Службы procd: `nexusd`, `nexus-backend` (автозапуск, перезапуск при падении).
  Логи: `logread | grep nexus`. LuCI на порту 80 не затрагивается.
- Конфиг `/etc/nexus/nexus.conf` (общий для обоих): пути АЦП, проценты, допуск, UART каждого
  слота, порт. Обновление **не перезаписывает** ваш конфиг и хук (новые версии кладутся как `*.new`).
- **Пины модулей** (мультиплексор — `module-hook.sh` через `devmem` в Control Module `0x44E10000`; остальное — daemon):

  | Слот | UART | GPIO |
  |---|---|---|
  | 1 | UART1_TXD (pad 0x984), UART1_RXD (0x980), `/dev/ttyS1` | GPIO_115, GPIO_117 |
  | 2 | UART4_TXD (gpmc_wpn 0x874, режим 6), UART4_RXD (gpmc_wait0 0x870, режим 6), `/dev/ttyS4` | GPIO_48, GPIO_60 |

  RS-485: TXD/RXD → UART, две GPIO-линии — **DE и /RE** (в покое оба 0 = приём, при передаче оба 1).
  Реле: все четыре пина — GPIO, каналы 1–4 = GPIO `115,117,15,14` (слот 1) и `48,60,31,30` (слот 2)
  (`relay1_gpios`/`relay2_gpios`). Слот пуст: все пины — входы. Нужны `devmem`/`devmem2` и включённый UART4.
  Всё это допущения о вашей схеме — меняются в `nexus.conf`.
- **Кнопки и светодиоды.** Первая кнопка (reset) и первый светодиод (питание) не программируются. Кнопки
  считаются нажатыми при низком уровне (`btn_active_low=1`), светодиоды включаются высоким (`led_active_low=0`);
  пины этих линий должны быть уже переведены в GPIO вашим device tree.
- Удаление: `sh install.sh --remove` (конфиг и данные остаются) или `--purge`.
- Если с ПК не открывается: порт должен быть разрешён в зоне файрвола, к которой подключён ПК.
- Адреса вкладок вида `/#/monitoring` (HashRouter), 404 при обновлении страницы нет.

**Сценарии выполняются на устройстве.** Узел без входящих связей — корень. Корни «Кнопка» и «RS-485: Приём»
запускают цепочку при каждом событии (нажатие/кадр), остальные корни выполняются один раз при запуске.
`if/else` идёт по ветке true/false, `while` повторяет подключённые узлы. Переменные в условиях и в тексте
отправки (`{...}`): `BTN-1..3`, `LED-1..3`, `RELAY-<слот>.<канал>`, `RS485-<слот>.<№ или имя>` (задаются узлом
парсинга; числа в кадре — старший байт первым). Изменения графа применяются после «Стоп» → «Запустить».
Ошибки (нет модуля, нет ответа daemon) показываются в панели сценария.

**Вкладка «Устройство»:** светодиоды (слева) и кнопки (справа) анимируются по реальным GPIO, при наведении
на кнопку показывается время последнего нажатия, на реле-модуль — состояние каналов и АЦП; ПКМ по
RS-485 модулю открывает терминал (принятое ←, отправленное →, отправка текста/HEX), по реле — окно каналов.

Не определяется: Ethernet 2, USB и аудио больше не рисуются (их нет в новом SVG). Вход пока автоматический.
История графиков мониторинга хранится в памяти backend (15 мин).

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
