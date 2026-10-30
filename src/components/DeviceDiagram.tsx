import { useEffect, useRef } from 'react';
import rawSvg from '../assets/Web_GUI.svg?raw';
import type { IOState, PortState } from '../api/types';

// Must match the ids present in Web_GUI.svg. This file is the ONLY source of the device artwork.
export const HOVER_IDS = [
  'power', 'ethernet1', 'sdcard', 'mpu', 'module1', 'module2',
  'btn1', 'btn2', 'btn3', 'btn4', 'led1', 'led2', 'led3', 'led4'
];

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The module cards of Web_GUI.svg carry the static caption "Module 1" / "Module 2" (outlined glyphs).
 * A connected module is shown under its own name instead (RS485-0, Relay-0, ...); an empty slot keeps the caption.
 */
function setModuleLabel(card: SVGGElement, name: string | undefined) {
  const glyphs = card.querySelector<SVGGElement>(':scope > g[clip-path]');
  let txt = card.querySelector<SVGTextElement>(':scope > text.module-name');
  if (!name) {
    txt?.remove();
    if (glyphs) glyphs.style.display = '';
    return;
  }
  if (glyphs) glyphs.style.display = 'none';
  if (!txt) {
    txt = document.createElementNS(SVG_NS, 'text') as SVGTextElement;
    txt.setAttribute('class', 'module-name');
    txt.setAttribute('x', '30');
    txt.setAttribute('y', '70');
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('dominant-baseline', 'middle');
    txt.setAttribute('fill', '#FFFFFF');
    txt.setAttribute('font-size', '12');
    txt.setAttribute('font-family', 'Inter, system-ui, sans-serif');
    txt.style.pointerEvents = 'none';
    card.appendChild(txt);
  }
  txt.textContent = name;
}

/** Same dark red as the Power port in Web_GUI.svg */
const RELAY_COLOR = '#80201D';

interface Props {
  ports: PortState[];
  /** false until the first answer from the controller: nothing is shown as connected before that */
  ready: boolean;
  io: IOState | null;
  onHover: (id: string | null) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
}

/**
 * Renders src/assets/Web_GUI.svg as it is (Vite `?raw` import); nothing is drawn by code.
 * State is applied to the artwork's own layers:
 *  - ports/modules: the coloured fill fades in when connected (the white outline always stays)
 *  - LEDs (left): class `on` -> blue dot + glow + rays; the change is animated in CSS (theme.css)
 *  - buttons (right): class `pressed` -> the plunger slides in and the cap darkens
 */
export default function DeviceDiagram({ ports, ready, io, onHover, onContextMenu }: Props) {
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

  // ports + modules. The coloured fill fades in/out (CSS), so nothing flashes while data is loading.
  //  - RS-485 module: blue (the artwork's colour, like the interfaces)
  //  - relay module:  the same dark red as the Power port
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    for (const port of ports) {
      const card = host.querySelector(`#${port.id}`);
      if (!card) continue;
      card.classList.toggle('connected', ready && port.connected);
      const fillEl = card.querySelector<SVGElement>('.port-fill');
      if (fillEl) fillEl.style.fill = port.kind === 'module' && port.detectedType === 'relay' ? RELAY_COLOR : '';
      if (port.kind === 'module') setModuleLabel(card as SVGGElement, ready && port.connected ? port.name : undefined);
    }
  }, [ports, ready]);

  // The state is applied after the first paint (two frames), otherwise a page that is opened with the
  // LED already on would show it instantly instead of playing the switch-on animation.
  const afterPaint = (fn: () => void) => {
    let id2 = 0;
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(fn);
    });
    return () => {
      cancelAnimationFrame(id1);
      cancelAnimationFrame(id2);
    };
  };

  // LEDs: led1 is the power LED (always on), led2..led4 = programmable LED 1..3
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const set = (idx: number, on: boolean) => {
      host.querySelector(`#led${idx}`)?.classList.toggle('on', on);
      host.querySelector(`#led${idx}-rays`)?.classList.toggle('on', on);
    };
    return afterPaint(() => {
      set(1, true);
      for (let n = 1; n <= 3; n++) set(n + 1, !!io?.leds.find((l) => l.n === n)?.on);
    });
  }, [io]);

  // buttons: btn1 is reset (never animated), btn2..btn4 = programmable button 1..3
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return afterPaint(() => {
      for (let n = 1; n <= 3; n++) {
        host.querySelector(`#btn${n + 1}`)?.classList.toggle('pressed', !!io?.buttons.find((b) => b.n === n)?.pressed);
      }
    });
  }, [io]);

  return <div ref={hostRef} className="dev-diagram" style={{ width: '100%' }} dangerouslySetInnerHTML={{ __html: rawSvg }} />;
}
