import { useEffect, useRef } from 'react';
import rawSvg from '../assets/Web_GUI.svg?raw';
import type { IOState, PortState } from '../api/types';

// Must match the ids present in Web_GUI.svg. This file is the ONLY source of the device artwork.
export const HOVER_IDS = [
  'power', 'ethernet1', 'sdcard', 'mpu', 'module1', 'module2',
  'btn1', 'btn2', 'btn3', 'btn4', 'led1', 'led2', 'led3', 'led4'
];

interface Props {
  ports: PortState[];
  io: IOState | null;
  onHover: (id: string | null) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
}

/**
 * Renders src/assets/Web_GUI.svg as it is (Vite `?raw` import); nothing is drawn by code.
 * State is applied to the artwork's own layers:
 *  - ports/modules: the coloured fill is cleared when nothing is connected (the white outline stays)
 *  - LEDs (left): class `on` -> blue dot + glow + rays; the change is animated in CSS (theme.css)
 *  - buttons (right): class `pressed` -> the plunger slides in and the cap darkens
 */
export default function DeviceDiagram({ ports, io, onHover, onContextMenu }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // listeners are attached once; keep the newest callbacks in refs so they never go stale
  const hoverRef = useRef(onHover);
  const ctxRef = useRef(onContextMenu);
  hoverRef.current = onHover;
  ctxRef.current = onContextMenu;

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
    for (const id of HOVER_IDS) {
      const el = host.querySelector<SVGElement>(`#${id}`);
      if (!el) continue;
      el.style.cursor = id === 'mpu' ? 'default' : 'pointer';
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
  }, []);

  // ports + modules
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    for (const port of ports) {
      const card = host.querySelector(`#${port.id}`);
      const fillEl = card?.querySelector<SVGElement>('.port-fill');
      if (fillEl) fillEl.style.fill = port.connected ? '' : 'none';
    }
  }, [ports]);

  // LEDs: led1 is the power LED (always on), led2..led4 = programmable LED 1..3
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const set = (idx: number, on: boolean) => {
      host.querySelector(`#led${idx}`)?.classList.toggle('on', on);
      host.querySelector(`#led${idx}-rays`)?.classList.toggle('on', on);
    };
    set(1, true);
    for (let n = 1; n <= 3; n++) set(n + 1, !!io?.leds.find((l) => l.n === n)?.on);
  }, [io]);

  // buttons: btn1 is reset (never animated), btn2..btn4 = programmable button 1..3
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    for (let n = 1; n <= 3; n++) {
      host.querySelector(`#btn${n + 1}`)?.classList.toggle('pressed', !!io?.buttons.find((b) => b.n === n)?.pressed);
    }
  }, [io]);

  return <div ref={hostRef} style={{ width: '100%' }} dangerouslySetInnerHTML={{ __html: rawSvg }} />;
}
