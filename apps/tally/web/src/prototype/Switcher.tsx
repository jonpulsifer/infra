import { ChevronLeft, ChevronRight, Moon, Sun } from 'lucide-react';

export function Switcher<K extends string>({
  keys,
  current,
  label,
  onChange,
  dark,
  onToggleDark,
}: {
  keys: readonly K[];
  current: K;
  label: string;
  onChange: (k: K) => void;
  dark: boolean;
  onToggleDark: () => void;
}) {
  const i = keys.indexOf(current);
  const prev = keys[(i - 1 + keys.length) % keys.length];
  const next = keys[(i + 1) % keys.length];
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 999,
        background: '#ff2d55',
        color: '#fff',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        boxShadow: '0 8px 24px rgba(0,0,0,.35)',
        userSelect: 'none',
      }}
    >
      <button
        type="button"
        onClick={() => onChange(prev)}
        aria-label="previous variant"
        style={btn}
      >
        <ChevronLeft size={16} />
      </button>
      <span>
        PROTOTYPE {current.toUpperCase()} · {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(next)}
        aria-label="next variant"
        style={btn}
      >
        <ChevronRight size={16} />
      </button>
      <span style={{ opacity: 0.5 }}>|</span>
      <button
        type="button"
        onClick={onToggleDark}
        aria-label="toggle theme"
        style={btn}
      >
        {dark ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </div>
  );
}

const btn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: 999,
  border: 0,
  background: 'rgba(255,255,255,.18)',
  color: '#fff',
  cursor: 'pointer',
};
