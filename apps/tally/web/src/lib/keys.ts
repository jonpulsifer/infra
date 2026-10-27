export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return (
    !!t &&
    (t.tagName === 'INPUT' ||
      t.tagName === 'SELECT' ||
      t.tagName === 'TEXTAREA' ||
      t.isContentEditable)
  );
}
