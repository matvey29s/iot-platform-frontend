import { useEffect, useState } from 'react';
import * as api from '../api';
import type { ModuleType, RegisterTableRow, Rs485Config, RelayConfig } from '../api/types';

interface Props {
  portId: string;
  moduleType: ModuleType;
  onClose: () => void;
}

const DEFAULT_RS485: Rs485Config = {
  baudRate: 9600,
  parity: 'none',
  dataBits: 8,
  stopBits: 1,
  devicePath: '/dev/ttyRS485-1',
  protocol: 'modbus_rtu'
};

const DEFAULT_RELAY: RelayConfig = { channels: 8, safeState: 'all_off' };

export default function ModuleConfigModal({ portId, moduleType, onClose }: Props) {
  const [tab, setTab] = useState<'port' | 'registers'>('port');
  const [rs485, setRs485] = useState<Rs485Config>(DEFAULT_RS485);
  const [relay, setRelay] = useState<RelayConfig>(DEFAULT_RELAY);
  const [rows, setRows] = useState<RegisterTableRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.fetchModuleConfig(portId).then((cfg) => {
      if (!cfg) return;
      if (moduleType === 'rs485') setRs485(cfg as Rs485Config);
      else setRelay(cfg as RelayConfig);
    });
    if (moduleType === 'rs485') {
      api.fetchRegisterTable(portId).then(setRows);
    }
  }, [portId, moduleType]);

  async function savePort(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await api.saveModuleConfig(portId, moduleType === 'rs485' ? rs485 : relay);
    setSaving(false);
    if (!res.ok) return setError(res.error ?? 'Ошибка сохранения');
    onClose();
  }

  async function saveRegisters() {
    setSaving(true);
    await api.saveRegisterTable(portId, rows);
    setSaving(false);
  }

  function addRow() {
    setRows((r) => [...r, { byteIndex: r.length ? r[r.length - 1].byteIndex + 2 : 0, name: '', dataType: 'uint16', description: '' }]);
  }
  function removeRow(i: number) {
    setRows((r) => r.filter((_, idx) => idx !== i));
  }
  function updateRow(i: number, patch: Partial<RegisterTableRow>) {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  return (
    <div style={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card" style={styles.modal}>
        <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>
          Модуль {portId.replace('module', '')} — {moduleType === 'rs485' ? 'RS-485' : 'Реле'}
        </h2>

        {moduleType === 'rs485' && (
          <div style={styles.tabs}>
            <button className={`btn ${tab === 'port' ? 'primary' : ''}`} onClick={() => setTab('port')} type="button">
              Параметры порта
            </button>
            <button className={`btn ${tab === 'registers' ? 'primary' : ''}`} onClick={() => setTab('registers')} type="button">
              Таблица регистров
            </button>
          </div>
        )}

        {tab === 'port' && moduleType === 'rs485' && (
          <form onSubmit={savePort} style={styles.form}>
            <Field label="Скорость (бод)">
              <select value={rs485.baudRate} onChange={(e) => setRs485({ ...rs485, baudRate: Number(e.target.value) })}>
                {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </Field>
            <Field label="Чётность">
              <select value={rs485.parity} onChange={(e) => setRs485({ ...rs485, parity: e.target.value as Rs485Config['parity'] })}>
                <option value="none">Нет</option>
                <option value="even">Чётная</option>
                <option value="odd">Нечётная</option>
              </select>
            </Field>
            <Field label="Бит данных">
              <select value={rs485.dataBits} onChange={(e) => setRs485({ ...rs485, dataBits: Number(e.target.value) as 7 | 8 })}>
                <option value={8}>8</option>
                <option value={7}>7</option>
              </select>
            </Field>
            <Field label="Стоп-биты">
              <select value={rs485.stopBits} onChange={(e) => setRs485({ ...rs485, stopBits: Number(e.target.value) as 1 | 2 })}>
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </Field>
            <Field label="Путь до устройства">
              <input value={rs485.devicePath} onChange={(e) => setRs485({ ...rs485, devicePath: e.target.value })} />
            </Field>
            <Field label="Протокол">
              <select value={rs485.protocol} onChange={(e) => setRs485({ ...rs485, protocol: e.target.value as Rs485Config['protocol'] })}>
                <option value="modbus_rtu">Modbus RTU</option>
                <option value="modbus_ascii">Modbus ASCII</option>
              </select>
            </Field>
            {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
            <Actions onClose={onClose} saving={saving} />
          </form>
        )}

        {tab === 'registers' && moduleType === 'rs485' && (
          <div style={styles.form}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th>Байт</th><th>Имя</th><th>Тип</th><th>Описание</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    <td><input type="number" style={{ width: 56 }} value={row.byteIndex} onChange={(e) => updateRow(i, { byteIndex: Number(e.target.value) })} /></td>
                    <td><input style={{ width: 100 }} value={row.name} onChange={(e) => updateRow(i, { name: e.target.value })} /></td>
                    <td>
                      <select value={row.dataType} onChange={(e) => updateRow(i, { dataType: e.target.value as RegisterTableRow['dataType'] })}>
                        {['uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'float32', 'bool'].map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td><input style={{ width: 140 }} value={row.description} onChange={(e) => updateRow(i, { description: e.target.value })} /></td>
                    <td><button type="button" className="btn" onClick={() => removeRow(i)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className="btn" onClick={addRow}>+ Добавить регистр</button>
            <Actions onClose={onClose} saving={saving} onSave={saveRegisters} />
          </div>
        )}

        {moduleType === 'relay' && (
          <form onSubmit={savePort} style={styles.form}>
            <Field label="Число каналов">
              <input type="number" min={1} max={16} value={relay.channels} onChange={(e) => setRelay({ ...relay, channels: Number(e.target.value) })} />
            </Field>
            <Field label="Состояние при потере связи">
              <select value={relay.safeState} onChange={(e) => setRelay({ ...relay, safeState: e.target.value as RelayConfig['safeState'] })}>
                <option value="keep">Сохранить</option>
                <option value="all_off">Все выключить</option>
                <option value="all_on">Все включить</option>
              </select>
            </Field>
            {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
            <Actions onClose={onClose} saving={saving} />
          </form>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
      {label}
      <div style={{ marginTop: 4 }}>{children}</div>
    </label>
  );
}

function Actions({ onClose, saving, onSave }: { onClose: () => void; saving: boolean; onSave?: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
      <button type="button" className="btn" onClick={onClose}>Отмена</button>
      {onSave ? (
        <button type="button" className="btn primary" onClick={onSave} disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить'}</button>
      ) : (
        <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить'}</button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modal: { width: 420, maxHeight: '85vh', overflow: 'auto', padding: '20px 24px' },
  tabs: { display: 'flex', gap: 8, margin: '10px 0 14px' },
  form: { display: 'flex', flexDirection: 'column' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 10 }
};
