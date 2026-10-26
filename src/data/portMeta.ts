export interface PortMeta {
  title: string;
  description: string;
  connectTo: string;
}

export const PORT_META: Record<string, PortMeta> = {
  power: { title: 'Power', description: 'Питание контроллера. Светодиод питания горит, пока устройство включено.', connectTo: '24 В DC, промышленный блок питания.' },
  ethernet1: { title: 'Ethernet 1', description: 'Сетевой интерфейс. «Подключено» означает наличие линка (carrier).', connectTo: 'RJ45 кабель до ПК/коммутатора.' },
  sdcard: { title: 'SD Card', description: 'Съёмное хранилище. «Подключено», если карта смонтирована.', connectTo: 'microSD, class 10 и выше.' },
  mpu: { title: 'MPU', description: 'Процессор AM3352 (ARM Cortex-A8) под управлением Linux.', connectTo: 'Внутренний элемент, не для подключения.' },
  module1: { title: 'Модуль 1', description: 'Тип определяется по АЦП канала 0: ≈16,4% от максимума — RS-485, ≈91,6% — реле (допуск ±5%).', connectTo: 'Модуль RS-485 или релейный модуль.' },
  module2: { title: 'Модуль 2', description: 'Тип определяется по АЦП канала 1: ≈16,4% от максимума — RS-485, ≈91,6% — реле (допуск ±5%).', connectTo: 'Модуль RS-485 или релейный модуль.' }
};

/** Buttons are on the right edge of the picture, LEDs on the left; the first of each is fixed. */
export const BUTTON_META = [
  { id: 'btn1', title: 'Кнопка Reset', gpio: null, note: 'Сброс. Не программируется.' },
  { id: 'btn2', title: 'Кнопка 1', gpio: 66, note: '' },
  { id: 'btn3', title: 'Кнопка 2', gpio: 69, note: '' },
  { id: 'btn4', title: 'Кнопка 3', gpio: 45, note: '' }
];
export const LED_META = [
  { id: 'led1', title: 'Светодиод питания', gpio: null, note: 'Показывает питание. Не программируется.' },
  { id: 'led2', title: 'Светодиод 1', gpio: 49, note: '' },
  { id: 'led3', title: 'Светодиод 2', gpio: 112, note: '' },
  { id: 'led4', title: 'Светодиод 3', gpio: 20, note: '' }
];
