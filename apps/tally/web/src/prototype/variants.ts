import type { ComponentType } from 'react';
import type { Ledger } from '~/fixtures/types';
import a from '~/variants/a';
import b from '~/variants/b';
import c from '~/variants/c';

export type VariantProps = { ledger: Ledger; dark: boolean };
export type Variant = { name: string; Component: ComponentType<VariantProps> };

export const VARIANTS = { a, b, c } satisfies Record<string, Variant>;
export type VariantKey = keyof typeof VARIANTS;
