import { useEffect, useMemo, useState } from 'react';
import { buildLedger } from '~/fixtures/generate';
import type { Ledger } from '~/fixtures/types';
import { Switcher } from './Switcher';
import { VARIANTS, type VariantKey } from './variants';

function readParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function writeParam(name: string, value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  window.history.replaceState(null, '', url);
}

const KEYS = Object.keys(VARIANTS) as VariantKey[];

export function PrototypeRoot() {
  const [variant, setVariant] = useState<VariantKey>(() => {
    const v = readParam('variant');
    return v && v in VARIANTS ? (v as VariantKey) : 'a';
  });
  const [dark, setDark] = useState<boolean>(() => {
    const t = readParam('theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  const ledger: Ledger = useMemo(() => buildLedger(), []);

  useEffect(() => {
    writeParam('variant', variant);
  }, [variant]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    writeParam('theme', dark ? 'dark' : 'light');
  }, [dark]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable)
      )
        return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const i = KEYS.indexOf(variant);
      const next =
        e.key === 'ArrowRight'
          ? KEYS[(i + 1) % KEYS.length]
          : KEYS[(i - 1 + KEYS.length) % KEYS.length];
      setVariant(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [variant]);

  const { Component } = VARIANTS[variant];

  return (
    <>
      <Component ledger={ledger} dark={dark} />
      {import.meta.env.MODE !== 'production' || readParam('bar') !== 'off' ? (
        <Switcher
          keys={KEYS}
          current={variant}
          label={VARIANTS[variant].name}
          onChange={setVariant}
          dark={dark}
          onToggleDark={() => setDark((d) => !d)}
        />
      ) : null}
    </>
  );
}
