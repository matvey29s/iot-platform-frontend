import type { ScenarioNodeType } from '../api/types';

export type FieldType = 'text' | 'number' | 'select' | 'registerTable';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  default?: unknown;
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
    tooltip: 'Сравнивает значение регистра с заданным и направляет выполнение по одной из двух веток.',
    color: '#FF7300',
    hasInput: true,
    hasOutput: true,
    outputs: ['true', 'false'],
    fields: [
      { key: 'variable', label: 'Переменная (устройство.индекс)', type: 'text', default: 'RS485-1.1' },
      { key: 'operator', label: 'Оператор', type: 'select', options: ['==', '!=', '>', '<', '>=', '<='], default: '==' },
      { key: 'value', label: 'Значение', type: 'text', default: '0' }
    ]
  },
  while: {
    type: 'while',
    label: 'Цикл (while)',
    tooltip: 'Повторяет вложенную ветку, пока условие истинно. Будьте осторожны с условием выхода на встраиваемом устройстве.',
    color: '#FF7300',
    hasInput: true,
    hasOutput: true,
    fields: [
      { key: 'variable', label: 'Переменная (устройство.индекс)', type: 'text', default: 'RS485-1.1' },
      { key: 'operator', label: 'Оператор', type: 'select', options: ['==', '!=', '>', '<', '>=', '<='], default: '<' },
      { key: 'value', label: 'Значение', type: 'text', default: '100' },
      { key: 'maxIterations', label: 'Предохранитель: макс. итераций', type: 'number', default: 10000 }
    ]
  },
  rs485_receive: {
    type: 'rs485_receive',
    label: 'RS-485: Приём',
    tooltip: 'Принимает сырой кадр данных с интерфейса и сохраняет его в именованный массив для последующего разбора.',
    color: '#1C99FF',
    hasInput: true,
    hasOutput: true,
    fields: [{ key: 'arrayName', label: 'Имя массива данных', type: 'text', default: 'rawFrame1' }]
  },
  rs485_parse: {
    type: 'rs485_parse',
    label: 'RS-485: Парсинг',
    tooltip: 'Разбирает принятый кадр по таблице регистров (номер байта, имя, тип данных, описание).',
    color: '#1C99FF',
    hasInput: true,
    hasOutput: true,
    fields: [{ key: 'registerTable', label: 'Таблица регистров', type: 'registerTable' }]
  },
  rs485_send: {
    type: 'rs485_send',
    label: 'RS-485: Отправка',
    tooltip: 'Отправляет данные во внешнюю систему в выбранном формате.',
    color: '#1C99FF',
    hasInput: true,
    hasOutput: false,
    fields: [{ key: 'format', label: 'Формат', type: 'select', options: ['Excel', 'JSON'], default: 'JSON' }]
  },
  relay_set: {
    type: 'relay_set',
    label: 'Реле: Вкл/Выкл',
    tooltip: 'Включает или выключает указанный канал релейного модуля.',
    color: '#2ecf7a',
    hasInput: true,
    hasOutput: true,
    fields: [
      { key: 'channel', label: 'Канал', type: 'number', default: 1 },
      { key: 'state', label: 'Состояние', type: 'select', options: ['ON', 'OFF'], default: 'ON' }
    ]
  }
};

export function defaultConfigFor(type: ScenarioNodeType): Record<string, unknown> {
  const def = NODE_DEFS[type];
  const cfg: Record<string, unknown> = {};
  for (const f of def.fields) cfg[f.key] = f.type === 'registerTable' ? [] : f.default;
  return cfg;
}
