import type { ScenarioNodeType } from '../api/types';

interface IconProps {
  size?: number;
  color?: string;
}

/**
 * Original 24x24 line icons, drawn for this project (no third-party icon set).
 * One consistent grammar: 1.8px round stroke, a single accent detail per icon.
 */
const base = (size: number, color: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: color,
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
});

/** if/else: decision diamond whose stem splits into two flowchart branches. */
export function IfElseIcon({ size = 22, color = 'currentColor' }: IconProps) {
  return (
    <svg {...base(size, color)}>
      <path d="M12 1.8 17.4 7.2 12 12.6 6.6 7.2z" />
      <path d="M12 12.6V15.5M6.5 19.5v-4h11v4" />
      <circle cx="6.5" cy="20.4" r="1.5" fill={color} stroke="none" />
      <circle cx="17.5" cy="20.4" r="1.5" fill={color} stroke="none" />
    </svg>
  );
}

/** while: loop arrow returning to its start, with a "run" triangle at the centre. */
export function WhileIcon({ size = 22, color = 'currentColor' }: IconProps) {
  return (
    <svg {...base(size, color)}>
      <path d="M20.2 12a8.2 8.2 0 1 1-2.6-6" />
      <path d="M20.6 2.8v4.6h-4.6" />
      <path d="M10 8.6v6.8l5.6-3.4z" fill={color} stroke="none" />
    </svg>
  );
}

/** RS-485 receive: arrow flowing INTO an open array bracket on the right. */
export function Rs485ReceiveIcon({ size = 22, color = 'currentColor' }: IconProps) {
  return (
    <svg {...base(size, color)}>
      <path d="M15.5 5.5h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-4" />
      <path d="M2.5 12h12.2M10.6 7.9l4.1 4.1-4.1 4.1" />
    </svg>
  );
}

/** RS-485 parse: a data frame in byte cells, fanning out into named fields. */
export function Rs485ParseIcon({ size = 22, color = 'currentColor' }: IconProps) {
  return (
    <svg {...base(size, color)}>
      <rect x="2.5" y="3" width="19" height="7" rx="1.8" />
      <path d="M8.8 3v7M15.2 3v7" />
      <path d="M12 10v3.4M12 13.4H6v2.6M12 13.4h6v2.6" />
      <rect x="3.2" y="16.4" width="5.6" height="4.2" rx="1.2" />
      <rect x="15.2" y="16.4" width="5.6" height="4.2" rx="1.2" />
    </svg>
  );
}

/** RS-485 send: arrow flowing OUT of an open array bracket on the left. */
export function Rs485SendIcon({ size = 22, color = 'currentColor' }: IconProps) {
  return (
    <svg {...base(size, color)}>
      <path d="M8.5 5.5h-4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h4" />
      <path d="M9.3 12h12.2M17.4 7.9l4.1 4.1-4.1 4.1" />
    </svg>
  );
}

/** Relay: coil (with winding zigzag) on the left drives a lever contact on the right. */
export function RelayIcon({ size = 22, color = 'currentColor' }: IconProps) {
  return (
    <svg {...base(size, color)}>
      <rect x="2.5" y="8.5" width="9.5" height="11" rx="1.9" />
      <path d="M4.6 14h1.5l1.1-2.7 1.8 5.4 1.1-2.7h.7" strokeWidth={1.5} />
      <path d="M14.8 17.5 20.4 6.8" />
      <circle cx="14.8" cy="17.5" r="1.7" fill={color} stroke="none" />
      <circle cx="21" cy="17.5" r="1.7" fill={color} stroke="none" />
    </svg>
  );
}

const ICONS: Record<ScenarioNodeType, (p: IconProps) => JSX.Element> = {
  if_else: IfElseIcon,
  while: WhileIcon,
  rs485_receive: Rs485ReceiveIcon,
  rs485_parse: Rs485ParseIcon,
  rs485_send: Rs485SendIcon,
  relay_set: RelayIcon
};

export function NodeIcon({ type, size = 22, color }: { type: ScenarioNodeType } & IconProps) {
  const Icon = ICONS[type];
  return <Icon size={size} color={color} />;
}
