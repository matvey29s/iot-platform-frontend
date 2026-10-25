import { useEffect, useRef } from 'react';
import rawSvg from '../assets/Web_GUI.svg?raw';
import type { PortState } from '../api/types';

// Must match the <g id="..."> groups actually present in Web_GUI.svg.
// This is the ONLY source of the device artwork used anywhere in the app.
export const PORT_IDS = ['power', 'ethernet1', 'ethernet2', 'usb', 'audioIn', 'audioOut', 'sdcard', 'lcd', 'modules'];

interface Props {
  ports: PortState[];
  onHover: (id: string | null) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
}

/**
 * This renders src/assets/Web_GUI.svg byte-for-byte (via Vite's `?raw`
 * import) -- no new shapes, colors or layout are generated. The only thing
 * this component does beyond that is attach event listeners and toggle the
 * existing `.port-fill` element's `fill` style, exactly the technique used
 * (and pixel-verified against the original file) in the standalone HTML/Go
 * build earlier in this project.
 */
export default function DeviceDiagram({ ports, onHover, onContextMenu }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // listeners are attached once; keep the newest callbacks in refs so they never go stale
  const hoverRef = useRef(onHover);
  const ctxRef = useRef(onContextMenu);
  hoverRef.current = onHover;
  ctxRef.current = onContextMenu;

  // Wire interactions once, directly on the SVG's own elements.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const svgEl = host.querySelector('svg');
    if (svgEl) {
      svgEl.style.width = '100%';
      svgEl.style.height = 'auto';
      svgEl.style.display = 'block';
    }

    const cleanups: Array<() => void> = [];
    for (const id of PORT_IDS) {
      const el = host.querySelector<SVGElement>(`#${id}`);
      if (!el) continue;
      el.style.cursor = 'pointer';
      el.setAttribute('tabindex', '0');

      const enter = () => hoverRef.current(id);
      const leave = () => hoverRef.current(null);
      const ctx = (e: Event) => {
        e.preventDefault();
        const m = e as MouseEvent;
        ctxRef.current(id, m.clientX, m.clientY);
      };

      el.addEventListener('mouseenter', enter);
      el.addEventListener('mouseleave', leave);
      el.addEventListener('contextmenu', ctx);
      cleanups.push(() => {
        el.removeEventListener('mouseenter', enter);
        el.removeEventListener('mouseleave', leave);
        el.removeEventListener('contextmenu', ctx);
      });
    }
    return () => cleanups.forEach((c) => c());
    // rawSvg is static, host content doesn't change -- wire once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect live port state onto the artwork's existing fill/outline layers.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    for (const port of ports) {
      const card = host.querySelector(`#${port.id}`);
      if (!card) continue;
      const fillEl = card.querySelector<SVGElement>('.port-fill');
      if (!fillEl) continue;

      if (fillEl.classList.contains('port-fill-solid')) {
        // LCD bar: no sibling outline path in the source artwork, so draw
        // one via stroke when inactive instead of just clearing the fill.
        if (port.connected) {
          fillEl.style.fill = '';
          fillEl.style.stroke = '';
          fillEl.style.strokeWidth = '';
        } else {
          fillEl.style.fill = 'none';
          fillEl.style.stroke = '#ffffff';
          fillEl.style.strokeWidth = '1.5';
        }
      } else {
        // Every other port already has a sibling white outline path. Clearing
        // just the colored fill reveals that outline against the chassis.
        fillEl.style.fill = port.connected ? '' : 'none';
      }
    }
  }, [ports]);

  return <div ref={hostRef} style={{ width: '100%' }} dangerouslySetInnerHTML={{ __html: rawSvg }} />;
}
