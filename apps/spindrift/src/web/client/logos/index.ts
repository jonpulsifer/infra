/**
 * Platform marks, keyed by name, valued by bundle URL.
 *
 * The SVGs sit beside this file because `bundle.ts` serves exactly what the
 * build emitted — a file that no module imports never reaches `dist/` and so
 * has no URL to render. Importing them here puts them in the client graph;
 * `Bun.build` copies each one out content-hashed and rewrites the import to
 * its served path.
 *
 * Squares except `gvisor`, which upstream only publishes as a 2:1 wordmark.
 * Size these with CSS against the `viewBox`; do not assume a common ratio.
 */
import argoCd from './argo-cd.svg';
import certManager from './cert-manager.svg';
import cilium from './cilium.svg';
import cloudflare from './cloudflare.svg';
import cloudflareWorkers from './cloudflare-workers.svg';
import cloudnativepg from './cloudnativepg.svg';
import firebase from './firebase.svg';
import flux from './flux.svg';
import github from './github.svg';
import googleCloud from './google-cloud.svg';
import gvisor from './gvisor.svg';
import helm from './helm.svg';
import kubernetes from './kubernetes.svg';
import nixos from './nixos.svg';
import opentelemetry from './opentelemetry.svg';
import opentofu from './opentofu.svg';
import prometheus from './prometheus.svg';
import sops from './sops.svg';
import terraform from './terraform.svg';
import vercel from './vercel.svg';

export const logos = {
  'argo-cd': argoCd,
  'cert-manager': certManager,
  cilium,
  cloudflare,
  'cloudflare-workers': cloudflareWorkers,
  cloudnativepg,
  firebase,
  flux,
  github,
  'google-cloud': googleCloud,
  gvisor,
  helm,
  kubernetes,
  nixos,
  opentelemetry,
  opentofu,
  prometheus,
  sops,
  terraform,
  vercel,
} as const;

export type LogoName = keyof typeof logos;
