import { useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface Point {
  t: number; // epoch ms
  v: number;
}

interface Props {
  title: string;
  subtitle?: string;
  unit: string; // e.g. "%" or " МБ"
  points: Point[];
  yMax: number; // fixed axis top (100 for %, total RAM for MB)
  color: string; // series color (mark only; text always uses ink tokens)
  ariaLabel: string;
  formatValue?: (v: number) => string;
}

const H = 250;
const M = { top: 14, right: 64, bottom: 28, left: 46 };

const pad2 = (n: number) => String(n).padStart(2, '0');
const hms = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const hm = (t: number) => hms(t).slice(0, 5);

/**
 * Single-series line chart (no dual axis; two measures = two charts).
 * 2px line, ~10% area wash, recessive hairline grid, end-dot with a surface
 * ring, one end label, crosshair + tooltip that snaps to the nearest sample,
 * and a table view so no value is reachable only through hover.
 */
export default function TimeSeriesChart({ title, subtitle, unit, points, yMax, color, ariaLabel, formatValue }: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Draw at the real pixel width (1 unit = 1 px) so text never gets scaled down.
  const [W, setW] = useState(520);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const apply = () => setW(Math.max(280, Math.round(el.clientWidth)));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);
  const fmt = formatValue ?? ((v: number) => v.toFixed(0));

  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const { x, y, path, area, xTicks, yTicks } = useMemo(() => {
    const t0 = points.length ? points[0].t : 0;
    const t1 = points.length > 1 ? points[points.length - 1].t : t0 + 1;
    const x = (t: number) => M.left + ((t - t0) / (t1 - t0 || 1)) * iw;
    const y = (v: number) => M.top + ih - (Math.min(v, yMax) / yMax) * ih;
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
    const area = points.length ? `${d}L${x(t1).toFixed(1)} ${M.top + ih}L${x(t0).toFixed(1)} ${M.top + ih}Z` : '';
    const xTicks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4);
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
    return { x, y, path: d, area, xTicks, yTicks };
  }, [points, yMax, iw, ih, W]);

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const svg = svgRef.current;
    if (!svg || !points.length) return;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dd = Math.abs(x(points[i].t) - px);
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    }
    setHoverIdx(best);
  }

  const last = points[points.length - 1];
  const hp = hoverIdx !== null ? points[hoverIdx] : null;
  const tipLeft = hp ? (x(hp.t) / W) * 100 : 0;

  return (
    <section className="card" style={st.card} aria-label={ariaLabel}>
      <header style={st.head}>
        <div>
          <h2 style={st.title}>{title}</h2>
          {subtitle && <div style={st.sub}>{subtitle}</div>}
        </div>
        <div style={st.tabs} role="tablist" aria-label="Вид">
          <button role="tab" aria-selected={!table} className={`seg ${!table ? 'on' : ''}`} onClick={() => setTable(false)}>График</button>
          <button role="tab" aria-selected={table} className={`seg ${table ? 'on' : ''}`} onClick={() => setTable(true)}>Таблица</button>
        </div>
      </header>

      {table ? (
        <div style={st.tableWrap}>
          <table style={st.table}>
            <thead>
              <tr><th style={st.th}>Время</th><th style={{ ...st.th, textAlign: 'right' }}>{title}</th></tr>
            </thead>
            <tbody>
              {[...points].reverse().slice(0, 60).map((p) => (
                <tr key={p.t}>
                  <td style={st.td}>{hms(p.t)}</td>
                  <td style={{ ...st.td, textAlign: 'right' }}>{fmt(p.v)}{unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={st.tableNote}>Последние 60 замеров из {points.length}</div>
        </div>
      ) : (
        <div ref={boxRef} style={{ position: 'relative', minWidth: 0, overflow: 'hidden' }}>
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={ariaLabel} style={{ display: 'block' }}>
            {/* recessive hairline grid + y labels (muted ink, not the series color) */}
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} stroke="var(--viz-grid)" strokeWidth={1} />
                <text x={M.left - 8} y={y(v) + 4} textAnchor="end" fontSize={12} fill="var(--viz-muted)">{fmt(v)}</text>
              </g>
            ))}
            {xTicks.map((t, i) => (
              <text key={i} x={x(t)} y={H - 8} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} fontSize={12} fill="var(--viz-muted)">{hm(t)}</text>
            ))}

            {points.length > 1 && (
              <>
                <path d={area} fill={color} opacity={0.1} />
                <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </>
            )}

            {/* end marker + single direct label at the latest value */}
            {last && (
              <g>
                <circle cx={x(last.t)} cy={y(last.v)} r={6} fill="var(--viz-surface)" />
                <circle cx={x(last.t)} cy={y(last.v)} r={4} fill={color} />
                <text x={x(last.t) + 10} y={y(last.v) + 4} fontSize={12} fontWeight={600} fill="var(--viz-ink)">{fmt(last.v)}{unit}</text>
              </g>
            )}

            {hp && (
              <g pointerEvents="none">
                <line x1={x(hp.t)} x2={x(hp.t)} y1={M.top} y2={M.top + ih} stroke="var(--viz-muted)" strokeWidth={1} />
                <circle cx={x(hp.t)} cy={y(hp.v)} r={6} fill="var(--viz-surface)" />
                <circle cx={x(hp.t)} cy={y(hp.v)} r={4} fill={color} />
              </g>
            )}

            {/* hit layer: wider than the line, snaps to the nearest sample */}
            <rect
              x={M.left}
              y={M.top}
              width={iw}
              height={ih}
              fill="transparent"
              tabIndex={0}
              onPointerMove={onMove}
              onPointerLeave={() => setHoverIdx(null)}
              onBlur={() => setHoverIdx(null)}
              onKeyDown={(e) => {
                if (!points.length) return;
                if (e.key === 'ArrowLeft') setHoverIdx((i) => Math.max(0, (i ?? points.length - 1) - 1));
                if (e.key === 'ArrowRight') setHoverIdx((i) => Math.min(points.length - 1, (i ?? points.length - 1) + 1));
                if (e.key === 'Escape') setHoverIdx(null);
              }}
              aria-label={`${title}: стрелки влево/вправо — значения по времени`}
            />
          </svg>

          {hp && (
            <div style={{ ...st.tip, left: `${tipLeft}%`, transform: tipLeft > 70 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }} role="status">
              <div style={st.tipValue}>
                <span style={{ ...st.key, background: color }} />
                {fmt(hp.v)}{unit}
              </div>
              <div style={st.tipTime}>{hms(hp.t)}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const st: Record<string, React.CSSProperties> = {
  card: { padding: '14px 16px 10px', background: 'var(--viz-surface)', minWidth: 0 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6, gap: 12 },
  title: { fontSize: 14, margin: 0, color: 'var(--viz-ink)' },
  sub: { fontSize: 12, color: 'var(--viz-muted)', marginTop: 2 },
  tabs: { display: 'flex', gap: 2, background: 'var(--surface-2)', borderRadius: 8, padding: 2 },
  tableWrap: { maxHeight: 240, overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { textAlign: 'left', color: 'var(--viz-muted)', fontWeight: 500, padding: '4px 6px', position: 'sticky', top: 0, background: 'var(--viz-surface)' },
  td: { padding: '3px 6px', borderTop: '1px solid var(--viz-grid)', color: 'var(--viz-ink)', fontVariantNumeric: 'tabular-nums' },
  tableNote: { fontSize: 11, color: 'var(--viz-muted)', padding: '6px 6px 2px' },
  tip: { position: 'absolute', top: 8, pointerEvents: 'none', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', fontSize: 12, whiteSpace: 'nowrap' },
  tipValue: { fontWeight: 700, fontSize: 14, color: 'var(--viz-ink)', display: 'flex', alignItems: 'center', gap: 6 },
  key: { width: 12, height: 2, borderRadius: 2, display: 'inline-block' },
  tipTime: { color: 'var(--viz-muted)', marginTop: 2 }
};
