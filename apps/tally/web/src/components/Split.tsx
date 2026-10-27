import { ChevronUp } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { cx, tw } from '~/lib/theme';

/**
 * The reader on the left, the inspector on the right. Below 1100px the
 * inspector folds into a bottom sheet whose bar always names its subject.
 */
export function Split({
  reader,
  inspector,
  peek,
  open,
  setOpen,
  readerRef,
  onInspectorEnter,
  onInspectorLeave,
}: {
  reader: ReactNode;
  inspector: ReactNode;
  peek: ReactNode;
  open: boolean;
  setOpen: (o: boolean) => void;
  readerRef?: RefObject<HTMLDivElement | null>;
  onInspectorEnter?: () => void;
  onInspectorLeave?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <div
        ref={readerRef}
        className="min-w-0 flex-1 overflow-auto pb-36 [scrollbar-gutter:stable] min-[1100px]:pb-16"
      >
        {reader}
      </div>
      <aside
        aria-label="Inspector"
        onPointerEnter={onInspectorEnter}
        onPointerLeave={onInspectorLeave}
        className={cx(
          'flex flex-col',
          tw.surface,
          tw.rule,
          'min-[1100px]:static min-[1100px]:w-[432px] min-[1100px]:shrink-0 min-[1100px]:border-l min-[1400px]:w-[480px]',
          'max-[1099px]:fixed max-[1099px]:right-0 max-[1099px]:pb-14 max-[1099px]:bottom-0 max-[1099px]:left-[52px] max-[1099px]:z-40 max-[1099px]:border-t max-[1099px]:shadow-[0_-10px_30px_-12px_rgba(0,0,0,0.25)] md:max-[1099px]:left-[188px] dark:max-[1099px]:shadow-[0_-10px_30px_-12px_rgba(0,0,0,0.7)]',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className={cx(
            'flex h-11 shrink-0 items-center gap-2 px-4 text-left text-[12px] min-[1100px]:hidden',
            open && cx('border-b', tw.rule),
          )}
        >
          <span className={cx(tw.label, tw.ink3)}>Inspector</span>
          <span className={cx('min-w-0 flex-1 truncate', tw.ink)}>{peek}</span>
          <ChevronUp
            size={14}
            className={cx(
              'shrink-0 transition-transform',
              tw.ink3,
              open && 'rotate-180',
            )}
          />
        </button>
        <div
          className={cx(
            'min-h-0 flex-1 overflow-auto max-[1099px]:max-h-[58vh] min-[1100px]:pb-16',
            open ? 'rf-sheet' : 'max-[1099px]:hidden',
          )}
        >
          {inspector}
        </div>
      </aside>
    </div>
  );
}
