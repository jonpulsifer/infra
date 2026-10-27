import type { ComponentType } from 'react';
import type { Ledger } from '~/fixtures/types';
import a from '~/variants/a';
import b from '~/variants/b';
import c from '~/variants/c';
import d from '~/variants/d';
import e from '~/variants/e';
import f from '~/variants/f';

export type VariantProps = { ledger: Ledger; dark: boolean };
export type Variant = { name: string; Component: ComponentType<VariantProps> };

export const VARIANTS = { a, b, c, d, e, f } satisfies Record<string, Variant>;
export type VariantKey = keyof typeof VARIANTS;
