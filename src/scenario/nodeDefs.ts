import type { ScenarioNodeType } from '../api/types';

export type FieldType = 'text' | 'number' | 'select' | 'registerTable' | 'module' | 'variable';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
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
  /** if_else has two named outputs instead of one. */
  outputs?: string[];
  fields: FieldDef[];
}

export const NODE_DEFS: Record<ScenarioNodeType, NodeDef> = {
  if_else: {
    type: 'if_else',
    label: 'Условие (if/else)',
    tooltip: 'Сравнивает переменную (кнопка BTN-1, светодиод LED-2, реле Relay-0, регистр RS485-0.1) с числом и направляет выполнение в ветку true или false.',
    color: '#FF7300',
    hasInput: true,
    hasOutput: true,
    outputs: ['true', 'false'],
    fields: [
      { key: 'variable', label: 'Переменная', type: 'variable', default: 'BTN-1' },
      { key: 'operator', label: 'Оператор', type: 'select', options: ['==', '!=', '>', '<', '>=', '<='], default: '==' },
      { key: 'value', label: 'Значение (число или переменная)', type: 'variable', default: '1' }
    ]
  },
  while: {
    type: 'while',
    label: 'Цикл (while)',
    tooltip: 'Повторяет подключённые к нему узлы, пока условие истинно (с паузой между повторами). Есть предохранитель по числу итераций.',
    color: '#FF7300',
    hasInput: true,
    hasOutput: true,
    fields: [
      { key: 'variable', label: 'Переменная', type: 'variable', default: 'BTN-1' },
      { key: 'operator', label: 'Оператор', type: 'select', options: ['==', '!=', '>', '<', '>=', '<='], default: '==' },
      { key: 'value', label: 'Значение (число или переменная)', type: 'variable', default: '1' },
      { key: 'intervalMs', label: 'Пауза между повторами, мс', type: 'number', default: 100 },
      { key: 'maxIterations', label: 'Предохранитель: макс. итераций', type: 'number', default: 10000 }
    ]
  },
  rs485_receive: {
    type: 'rs485_receive',
    label: 'RS-485: Приём',
    tooltip: 'Ждёт кадр данных от модуля RS-485 (кадр = пауза 20 мс). Без входящей связи — запускает цепочку при каждом принятом кадре. Модуль выбирается по имени: RS485-0, RS485-1.',
    color: '#1C99FF',
    hasInput: true,
    hasOutput: true,
    fields: [{ key: 'module', label: 'Модуль RS-485', type: 'module', moduleType: 'rs485', default: '' }]
  },
  rs485_parse: {
    type: 'rs485_parse',
    label: 'RS-485: Парсинг',
    tooltip: 'Разбирает принятый кадр по таблице регистров (байт, имя, тип; старший байт первым). Значения доступны как RS485-0.№ и RS485-0.имя (имя модуля из «RS-485: Приём»).',
    color: '#1C99FF',
    hasInput: true,
    hasOutput: true,
    fields: [{ key: 'registerTable', label: 'Таблица регистров', type: 'registerTable' }]
  },
  rs485_send: {
    type: 'rs485_send',
    label: 'RS-485: Отправка',
    tooltip: 'Отправляет кадр через модуль RS-485. В тексте можно использовать переменные в фигурных скобках, например T={RS485-0.1}.',
    color: '#1C99FF',
    hasInput: true,
    hasOutput: false,
    fields: [
      { key: 'module', label: 'Модуль RS-485', type: 'module', moduleType: 'rs485', default: '' },
      { key: 'mode', label: 'Формат данных', type: 'select', options: ['Текст', 'HEX', 'JSON (переменные)'], default: 'Текст' },
      { key: 'data', label: 'Данные (в тексте: \\r \\n, {переменные})', type: 'text', default: 'hello\\r\\n' }
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
    tooltip: 'Запускает цепочку при нажатии (или отпускании) программируемой кнопки на корпусе. Кнопка 1 = GPIO66, 2 = GPIO69, 3 = GPIO45.',
    color: '#FFC83D',
    hasInput: false,
    hasOutput: true,
    fields: [
      { key: 'button', label: 'Кнопка (1 = GPIO66, 2 = GPIO69, 3 = GPIO45)', type: 'select', options: ['1', '2', '3'], default: '1' },
      { key: 'event', label: 'Событие', type: 'select', options: ['pressed', 'released'], default: 'pressed' }
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
  for (const f of def.fields) cfg[f.key] = f.type === 'registerTable' ? [] : f.default;
  return cfg;
}
