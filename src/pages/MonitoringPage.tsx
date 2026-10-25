import { useMemo, useState } from 'react';
import { useMetricsStore } from '../store/metricsStore';
import TimeSeriesChart from '../components/TimeSeriesChart';

const RANGES = [
  { id: '1m', label: '1 мин', ms: 60_000 },
  { id: '5m', label: '5 мин', ms: 300_000 },
  { id: '15m', label: '15 мин', ms: 900_000 }
] as const;

export default function MonitoringPage() {
  const info = useMetricsStore((s) => s.latest);
  const history = useMetricsStore((s) => s.history);
  const offline = useMetricsStore((s) => s.offline);
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('5m');

  const windowed = useMemo(() => {
    const ms = RANGES.find((r) => r.id === range)!.ms;
    const end = history.length ? history[history.length - 1].sampledAt : Date.now();
    return history.filter((p) => p.sampledAt >= end - ms);
  }, [history, range]);

  const cpu = useMemo(() => windowed.map((p) => ({ t: p.sampledAt, v: p.cpuUsagePercent })), [windowed]);
  const ram = useMemo(() => windowed.map((p) => ({ t: p.sampledAt, v: p.ramUsedMb })), [windowed]);

  if (!info) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 18, marginBottom: 16 }}>Мониторинг</h1>
        {offline ? (
          <div className="card" style={{ padding: 16, maxWidth: 560, borderColor: 'var(--danger)' }} role="alert">
            <b>Нет данных от контроллера</b>
            <div style={{ color: 'var(--muted)', marginTop: 6, fontSize: 13 }}>
              Backend не отвечает или не запущен daemon <code>nexusd</code>. Проверьте на устройстве:
              <code> logread | grep nexus</code>. Страница обновится сама, когда данные появятся.
            </div>
          </div>
        ) : (
          'Загрузка…'
        )}
      </div>
    );
  }

  const ramPct = Math.round((info.ramUsedMb / info.ramTotalMb) * 100);
  const diskPct = Math.round((info.diskUsedMb / info.diskTotalMb) * 100);

  return (
    <div style={{ padding: 24, maxWidth: 1080 }}>
      <h1 style={{ fontSize: 18, marginBottom: 16 }}>Мониторинг</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        <InfoCard label="Версия Linux" value={info.linuxVersion} />
        <InfoCard label="Модель CPU" value={info.cpuModel} />
        <InfoCard label="Время работы" value={formatUptime(info.uptimeSeconds)} />
        <InfoCard label="Загрузка CPU" value={`${info.cpuUsagePercent.toFixed(0)}%`} bar={info.cpuUsagePercent} />
        <InfoCard label="RAM" value={`${info.ramUsedMb.toFixed(0)} / ${info.ramTotalMb} МБ`} bar={ramPct} />
        <InfoCard label="Диск" value={`${info.diskUsedMb} / ${info.diskTotalMb} МБ`} bar={diskPct} />
      </div>

      {/* one filter row above the charts; it scopes both of them */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '24px 0 12px' }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Нагрузка во времени</h2>
        <div style={{ display: 'flex', gap: 2, background: 'var(--surface-2)', borderRadius: 8, padding: 2 }} role="group" aria-label="Период">
          {RANGES.map((r) => (
            <button key={r.id} className={`seg ${range === r.id ? 'on' : ''}`} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14 }}>
        <TimeSeriesChart
          title="Загрузка CPU"
          subtitle="Процент от всех ядер, замер каждые 3 с"
          unit="%"
          points={cpu}
          yMax={100}
          color="var(--viz-cpu)"
          ariaLabel="График загрузки CPU в процентах от времени"
        />
        <TimeSeriesChart
          title="Использование RAM"
          subtitle={`Занято из ${info.ramTotalMb} МБ, замер каждые 3 с`}
          unit=" МБ"
          points={ram}
          yMax={info.ramTotalMb}
          color="var(--viz-ram)"
          ariaLabel="График использования оперативной памяти в мегабайтах от времени"
        />
      </div>
    </div>
  );
}

function InfoCard({ label, value, bar }: { label: string; value: string; bar?: number }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</div>
      <div style={{ fontSize: 15, marginTop: 4 }}>{value}</div>
      {bar !== undefined && (
        <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-2)', marginTop: 8, overflow: 'hidden' }}>
          <div style={{ width: `${bar}%`, height: '100%', background: bar > 80 ? 'var(--danger)' : 'var(--accent)' }} />
        </div>
      )}
    </div>
  );
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h} ч ${m} мин`;
}
