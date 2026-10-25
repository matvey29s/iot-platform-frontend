export interface PortMeta {
  title: string;
  description: string;
  connectTo: string;
}

export const PORT_META: Record<string, PortMeta> = {
  power: { title: 'Power', description: 'Питание контроллера.', connectTo: '24В DC, промышленный блок питания.' },
  ethernet1: { title: 'Ethernet (1)', description: 'Первый Ethernet-интерфейс.', connectTo: 'RJ45 кабель до ПК/коммутатора.' },
  ethernet2: { title: 'Ethernet (2)', description: 'Второй Ethernet-интерфейс.', connectTo: 'RJ45 кабель до ПК/коммутатора.' },
  usb: { title: 'USB', description: 'USB-порт для накопителей/периферии.', connectTo: 'USB flash-накопитель или иное USB-устройство.' },
  audioIn: { title: 'Audio In', description: 'Линейный аудиовход.', connectTo: 'Микрофон или линейный источник сигнала.' },
  audioOut: { title: 'Audio Out', description: 'Линейный аудиовыход.', connectTo: 'Динамик, усилитель.' },
  sdcard: { title: 'SD Card', description: 'Съёмное хранилище (ОС, логи, прошивки).', connectTo: 'microSD, class 10 и выше.' },
  lcd: { title: 'LCD Display', description: 'Встроенный дисплей состояния.', connectTo: 'Внутренний, не для подключения пользователем.' },
  modules: {
    title: 'Modules (слот расширения)',
    description: 'Контроллер определяет тип подключённого модуля по ADC. ПКМ — настройка при обнаружении RS-485 или реле.',
    connectTo: 'Модуль реле, RS-485/RS-232/CAN интерфейс.'
  }
};
