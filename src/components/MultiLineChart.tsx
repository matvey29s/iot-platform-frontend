import { useLayoutEffect, useRef, useState } from 'react';

export interface Series {
  name: string;
  color: string;
  values: number[]; // one per time point
}

interface Props {
  title: string;
  subtitle?: string;
  times: number[];
  series: Series[];
  yMax: number;
  unit: string;
  ariaLabel: string;
}

const H = 250;
const M = { top: 14, right: 16, bottom: 28, left: 46 };
const pad2 = (n: number) => String(n).padStart(2, '0');
const hms = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/** One line per series (per CPU core), each in its own colour, shared axes, legend and a hover read-out of every series. */
export default function MultiLineChart({ title, subtitle, times, series, yMax, unit, ariaLabel }: Props) {
  const [W, setW] = useState(520);
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const apply = () => setW(Math.max(280, Math.round(el.clientWidth)));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const t0 = times[0] ?? 0;
  const t1 = times.length > 1 ? times[times.length - 1] : t0 + 1;
  const x = (t: number) => M.left + ((t - t0) / (t1 - t0 || 1)) * iw;
  const y = (v: number) => M.top + ih - (Math.min(v, yMax) / yMax) * ih;
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)} ${y(v).toFixed(1)}`).join('');

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    let bd = Infinity;
    times.forEach((t, i) => {
      const d = Math.abs(x(t) - px);
      if (d < bd) { bd = d; best = i; }
    });
    setHover(best);
  }

  return (
    <section className="card" style={{ padding: '14px 16px 10px', background: 'var(--viz-surface)', minWidth: 0 }} aria-label={ariaLabel}>
      <h2 style={{ fontSize: 14, margin: 0, color: 'var(--viz-ink)' }}>{title}</h2>
      {subtitle && <div style={{ fontSize: 12, color: 'var(--viz-muted)', marginTop: 2 }}>{subtitle}</div>}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '8px 0 4px', fontSize: 12, color: 'var(--viz-ink)' }}>
        {series.map((s) => (
          <span key={s.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 14, height: 3, borderRadius: 2, background: s.color, display: 'inline-block' }} />
            {s.name}: <b>{(s.values[s.values.length - 1] ?? 0).toFixed(0)}{unit}</b>
          </span>
        ))}
      </div>
      <div ref={boxRef} style={{ position: 'relative', minWidth: 0, overflow: 'hidden' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={ariaLabel} style={{ display: 'block' }}>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line x1={M.left} x2={W - M.right} y1={y(f * yMax)} y2={y(f * yMax)} stroke="var(--viz-grid)" />
              <text x={M.left - 8} y={y(f * yMax) + 4} textAnchor="end" fontSize={12} fill="var(--viz-muted)">{(f * yMax).toFixed(0)}</text>
            </g>
          ))}
          {[0, 1, 2, 3, 4].map((i) => {
            const t = t0 + ((t1 - t0) * i) / 4;
            return <text key={i} x={x(t)} y={H - 8} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} fontSize={12} fill="var(--viz-muted)">{hms(t).slice(0, 5)}</text>;
          })}
          {times.length > 1 && series.map((s) => <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
          {hover !== null && times[hover] !== undefined && (
            <line x1={x(times[hover])} x2={x(times[hover])} y1={M.top} y2={M.top + ih} stroke="var(--viz-muted)" />
          )}
          <rect x={M.left} y={M.top} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
        {hover !== null && times[hover] !== undefined && (
          <div style={{ position: 'absolute', top: 8, left: `${(x(times[hover]) / W) * 100}%`, transform: x(times[hover]) / W > 0.7 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)', pointerEvents: 'none', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', fontSize: 12, whiteSpace: 'nowrap' }} role="status">
            {series.map((s) => (
              <div key={s.name} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ width: 12, height: 3, background: s.color, display: 'inline-block' }} />
                {s.name}: <b>{(s.values[hover] ?? 0).toFixed(0)}{unit}</b>
              </div>
            ))}
            <div style={{ color: 'var(--viz-muted)', marginTop: 2 }}>{hms(times[hover])}</div>
          </div>
        )}
      </div>
    </section>
  );
}
