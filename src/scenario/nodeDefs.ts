import type { ScenarioNodeType } from '../api/types';

export type FieldType = 'text' | 'number' | 'select' | 'registerTable' | 'module' | 'variable' | 'conditions' | 'sendTable';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  /** shown instead of the raw option value */
  optionLabels?: Record<string, string>;
  default?: unknown;
  /** type 'module': which connected modules are offered */
  moduleType?: 'rs485' | 'relay';
}

export interface NodeDef {
  type: ScenarioNodeType;
  label: string;
  /** Short hint shown on hover, per the "educational tooltip" requirement. */
  tooltip: string;
  color: string;
  hasInput: boolean;
  hasOutput: boolean;
  fields: FieldDef[];
}

export const NODE_DEFS: Record<ScenarioNodeType, NodeDef> = {
  if_else: {
    type: 'if_else',
    label: 'Условие (if/else)',
    tooltip: 'До 10 условий. Выполняется ветка первого сработавшего условия, затем поток идёт в out. Если ни одно условие не выполнено — сразу в out.',
    color: '#FF7300',
    hasInput: true,
    hasOutput: true,
    fields: [{ key: 'conditions', label: 'Условия', type: 'conditions' }]
  },
  while: {
    type: 'while',
    label: 'Цикл (while)',
    tooltip: 'Пока условие истинно — выполняет ветку true и проверяет условие снова. Когда условие ложно — переходит в out.',
    color: '#FF7300',
    hasInput: true,
    hasOutput: true,
    fields: [
      { key: 'variable', label: 'Переменная', type: 'variable', default: 'BTN-1' },
      { key: 'operator', label: 'Оператор', type: 'select', options: ['==', '!=', '>', '<', '>=', '<='], default: '==' },
      { key: 'value', label: 'Значение (число или переменная)', type: 'variable', default: '1' },
      { key: 'intervalMs', label: 'Пауза между повторами, мс', type: 'number', default: 100 }
    ]
  },
  rs485_receive: {
    type: 'rs485_receive',
    label: 'RS-485: Приём',
    tooltip: 'Ждёт кадр данных от модуля RS-485 (кадр = пауза 20 мс), после этого поток идёт в out. Модуль выбирается по имени: RS485-0, RS485-1.',
    color: '#1C99FF',
    hasInput: true,
    hasOutput: true,
    fields: [{ key: 'module', label: 'Модуль RS-485', type: 'module', moduleType: 'rs485', default: '' }]
  },
  rs485_parse: {
    type: 'rs485_parse',
    label: 'RS-485: Парсинг',
    tooltip: 'Разбирает принятый кадр по таблице регистров (байт, имя, тип; старший байт первым). Имя строки становится переменной с таким же именем и описанием (вкладка «Переменные»).',
    color: '#1C99FF',
    hasInput: true,
    hasOutput: true,
    fields: [{ key: 'registerTable', label: 'Таблица регистров', type: 'registerTable' }]
  },
  rs485_send: {
    type: 'rs485_send',
    label: 'RS-485: Отправка',
    tooltip: 'Отправляет кадр через модуль RS-485. Кадр собирается из таблицы: значение (число или переменная), тип и порядок байт.',
    color: '#1C99FF',
    hasInput: true,
    hasOutput: true,
    fields: [
      { key: 'module', label: 'Модуль RS-485', type: 'module', moduleType: 'rs485', default: '' },
      { key: 'rows', label: 'Данные кадра', type: 'sendTable' }
    ]
  },
  relay_set: {
    type: 'relay_set',
    label: 'Реле: Вкл/Выкл',
    tooltip: 'Включает, выключает или переключает релейный модуль (у модуля один канал). Модуль выбирается по имени: Relay-0, Relay-1.',
    color: '#2ecf7a',
    hasInput: true,
    hasOutput: true,
    fields: [
      { key: 'module', label: 'Модуль реле', type: 'module', moduleType: 'relay', default: '' },
      { key: 'state', label: 'Состояние', type: 'select', options: ['ON', 'OFF', 'TOGGLE'], default: 'ON' }
    ]
  },
  button_event: {
    type: 'button_event',
    label: 'Кнопка',
    tooltip: 'Ждёт событие кнопки и затем идёт в out. Кнопка 1 = GPIO66, 2 = GPIO69, 3 = GPIO45.',
    color: '#FFC83D',
    hasInput: true,
    hasOutput: true,
    fields: [
      { key: 'button', label: 'Кнопка (1 = GPIO66, 2 = GPIO69, 3 = GPIO45)', type: 'select', options: ['1', '2', '3'], default: '1' },
      {
        key: 'event',
        label: 'Событие',
        type: 'select',
        options: ['level_pressed', 'level_released', 'rising', 'falling'],
        optionLabels: { level_pressed: 'Нажата', level_released: 'Не нажата', rising: 'Восходящий фронт (в момент нажатия)', falling: 'Нисходящий фронт (в момент отпускания)' },
        default: 'rising'
      }
    ]
  },
  led_set: {
    type: 'led_set',
    label: 'Светодиод',
    tooltip: 'Включает, выключает или переключает программируемый светодиод. LED 1 = GPIO49, 2 = GPIO112, 3 = GPIO20.',
    color: '#E85CFF',
    hasInput: true,
    hasOutput: true,
    fields: [
      { key: 'led', label: 'Светодиод (1 = GPIO49, 2 = GPIO112, 3 = GPIO20)', type: 'select', options: ['1', '2', '3'], default: '1' },
      { key: 'state', label: 'Состояние', type: 'select', options: ['ON', 'OFF', 'TOGGLE'], default: 'ON' }
    ]
  },
  parallel_gateway: {
    type: 'parallel_gateway',
    label: 'Параллельный шлюз',
    tooltip: 'Запускает несколько задач одновременно (вытесняющая многозадачность). Приоритет 0 — самый высокий. Если шлюз есть, он единственный старт сценария.',
    color: '#8F7CFF',
    hasInput: false,
    hasOutput: false,
    fields: [
      { key: 'priority', label: 'Приоритет (0 — наивысший)', type: 'number', default: 0 },
      { key: 'tasks', label: 'Число задач (1–10)', type: 'number', default: 2 }
    ]
  },
  delay: {
    type: 'delay',
    label: 'Задержка',
    tooltip: 'Приостанавливает выполнение цепочки на заданное число миллисекунд.',
    color: '#8FA6D6',
    hasInput: true,
    hasOutput: true,
    fields: [{ key: 'ms', label: 'Время, мс', type: 'number', default: 1000 }]
  }
};

export function defaultConfigFor(type: ScenarioNodeType): Record<string, unknown> {
  const def = NODE_DEFS[type];
  const cfg: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (f.type === 'registerTable' || f.type === 'sendTable') cfg[f.key] = [];
    else if (f.type === 'conditions') cfg[f.key] = [{ variable: 'BTN-1', operator: '==', value: '1' }];
    else cfg[f.key] = f.default;
  }
  if (type === 'rs485_send') cfg.mode = 'table';
  return cfg;
}

export interface HandleDef {
  id: string;
  label: string;
}

export const MAX_CONDITIONS = 10;
export const MAX_TASKS = 10;

export function conditionsOf(config: Record<string, unknown>): Array<{ variable: string; operator: string; value: string }> {
  const l = config.conditions;
  if (Array.isArray(l)) return l as Array<{ variable: string; operator: string; value: string }>;
  return [{ variable: String(config.variable ?? 'BTN-1'), operator: String(config.operator ?? '=='), value: String(config.value ?? '1') }];
}

/** Output connectors of a block. Every block except the gateway has the mandatory "out". */
export function outputHandles(type: ScenarioNodeType, config: Record<string, unknown>): HandleDef[] {
  switch (type) {
    case 'while':
      return [{ id: 'true', label: 'true' }, { id: 'out', label: 'out' }];
    case 'if_else':
      return [...conditionsOf(config).slice(0, MAX_CONDITIONS).map((_, i) => ({ id: `c${i + 1}`, label: `${i + 1}` })), { id: 'out', label: 'out' }];
    case 'parallel_gateway': {
      const n = Math.min(MAX_TASKS, Math.max(1, Number(config.tasks) || 1));
      return Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, label: `Task${i + 1}` }));
    }
    default:
      return [{ id: 'out', label: 'out' }];
  }
}
