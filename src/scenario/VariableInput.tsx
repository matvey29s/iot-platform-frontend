import { useEffect, useMemo, useRef, useState } from 'react';
import type { VariableOption } from './variables';

interface Props {
  value: string;
  onChange: (v: string) => void;
  options: VariableOption[];
  placeholder?: string;
}

/**
 * Text field with a drop-down of variables. The list shows only the variables whose name STARTS with what
 * the user has typed (letters and digits, any case); an empty field lists them all. Free text stays allowed
 * (a number, or a variable that only exists at run time).
 */
export default function VariableInput({ value, onChange, options, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    return options.filter((o) => o.name.toLowerCase().startsWith(q));
  }, [options, value]);

  useEffect(() => setActive(0), [value]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  function pick(v: string) {
    onChange(v);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && open && filtered[active]) {
      e.preventDefault();
      pick(filtered[active].name);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        style={{ width: '100%' }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && filtered.length > 0 && (
        <ul role="listbox" style={styles.list}>
          {filtered.map((o, i) => (
            <li
              key={o.name}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the input
                pick(o.name);
              }}
              onMouseEnter={() => setActive(i)}
              style={{ ...styles.item, background: i === active ? 'var(--surface-2)' : 'transparent' }}
            >
              <b style={{ fontSize: 12 }}>{o.name}</b>
              <span style={{ color: 'var(--muted)', fontSize: 11 }}>{o.source}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: {
    position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 20, margin: '2px 0 0', padding: 4, listStyle: 'none',
    maxHeight: 190, overflowY: 'auto', background: '#071a44', border: '1px solid var(--border)', borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
  },
  item: { display: 'flex', flexDirection: 'column', gap: 1, padding: '5px 8px', borderRadius: 6, cursor: 'pointer' }
};
