/**
 * The sign-in screen: enrolment on an unclaimed installation, passkey sign-in
 * on a claimed one. It names the installation by origin, since a signed-out
 * caller may not read the manifest.
 */
import { KeyRound, ShieldCheck } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { Principal } from '../../../commands/types.ts';
import { CeremonyAbandonedError, enrol, signIn } from '../../auth-client.ts';
import { Roflcopter } from '../../components/roflcopter.tsx';
import { Wordmark } from '../../components/wordmark.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { Field } from '../../ui/field.tsx';

export interface GateProps {
  /** Whether anybody has enrolled here yet; the server decides. */
  readonly claimed: boolean;
  readonly gatewayUnlinked?: boolean;
  readonly onSignedIn: (principal: Principal) => void;
}

export function Gate({
  claimed,
  gatewayUnlinked = false,
  onSignedIn,
}: GateProps) {
  return (
    <>
      <Roflcopter />
      <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center gap-6 px-5 py-12">
        <div className="flex flex-col items-center gap-2 text-center">
          <Wordmark setting="hero" className="text-foreground" />
          <p className="text-sm text-muted-foreground">
            Deploy to your own clusters and cloud projects. One button, one
            release.
          </p>
          <Installation />
        </div>
        {claimed ? (
          <SignIn gatewayUnlinked={gatewayUnlinked} onSignedIn={onSignedIn} />
        ) : (
          <Enrol onSignedIn={onSignedIn} />
        )}
      </main>
    </>
  );
}

/** The origin the passkey binds to. Renders nothing where there is no `location`. */
function Installation() {
  const host = typeof location === 'undefined' ? '' : location.host;
  if (host === '') return null;
  return (
    <p className="mt-1 font-mono text-caption text-subtle">
      signing in to {host}
    </p>
  );
}

/** What both states do with a result, so neither writes it twice. */
function useCeremony(onSignedIn: (principal: Principal) => void) {
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async (
    ceremony: () => Promise<
      | { ok: true; value: { principal: Principal } }
      | { ok: false; failure: { message: string } }
    >,
  ) => {
    setError(null);
    setRunning(true);
    try {
      const result = await ceremony();
      if (result.ok) {
        onSignedIn(result.value.principal);
      } else {
        setError(result.failure.message);
      }
    } catch (cause) {
      setError(
        cause instanceof CeremonyAbandonedError
          ? 'No passkey was offered. Try again, or use a device that has one.'
          : 'Something went wrong reaching this installation.',
      );
    } finally {
      setRunning(false);
    }
  };

  return { error, running, run };
}

function Enrol({ onSignedIn }: { onSignedIn: (p: Principal) => void }) {
  const [token, setToken] = useState('');
  const { error, running, run } = useCeremony(onSignedIn);

  return (
    <Card>
      <CardHeader>
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
        <div>
          <CardTitle>Claim this installation</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Nobody has enrolled here yet. The token below shipped in this
            installation&apos;s Secret, and it is spent the moment you finish —
            after that, this screen becomes a sign-in.
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => enrol(token.trim()));
          }}
        >
          <Field
            name="enrolment-token"
            label="Enrolment token"
            type="password"
            autoComplete="off"
            // The only box on this screen, so it takes focus.
            autoFocus
            value={token}
            placeholder="from SPINDRIFT_ENROLMENT_TOKEN"
            onChange={(event) => setToken(event.currentTarget.value)}
          />
          <Problem>{error}</Problem>
          <Button type="submit" disabled={running || token.trim() === ''}>
            <KeyRound aria-hidden="true" />
            {running ? 'Waiting for your passkey…' : 'Enrol a passkey'}
          </Button>
          <Ceremony running={running} />
        </form>
      </CardContent>
    </Card>
  );
}

function SignIn({
  gatewayUnlinked,
  onSignedIn,
}: {
  gatewayUnlinked: boolean;
  onSignedIn: (p: Principal) => void;
}) {
  const [token, setToken] = useState('');
  const { error, running, run } = useCeremony(onSignedIn);

  return (
    <Card>
      <CardHeader>
        <KeyRound aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
        <div>
          <CardTitle>Sign in</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Your passkey is all this needs — there is no username here.
          </p>
          {gatewayUnlinked && (
            <p className="mt-2 text-xs text-muted-foreground">
              This Gateway identity is not linked yet. Sign in with the root
              passkey, then link it in Settings.
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Problem>{error}</Problem>
        <Button disabled={running} onClick={() => void run(signIn)}>
          {running ? 'Waiting for your passkey…' : 'Continue with a passkey'}
        </Button>
        <Ceremony running={running} />
        <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-foreground">
            Recover with a rotated token
          </summary>
          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => enrol(token.trim()));
            }}
          >
            <p className="text-xs text-muted-foreground">
              Rotate{' '}
              <code className="font-mono">SPINDRIFT_ENROLMENT_TOKEN</code> in
              this installation&apos;s Secret first. Enrolling with the new
              value replaces every passkey and ends every existing session.
            </p>
            <Field
              name="recovery-token"
              label="Rotated enrolment token"
              type="password"
              autoComplete="off"
              value={token}
              placeholder="the new SPINDRIFT_ENROLMENT_TOKEN"
              onChange={(event) => setToken(event.currentTarget.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={running || token.trim() === ''}
            >
              <ShieldCheck aria-hidden="true" />
              {running ? 'Waiting for your passkey…' : 'Replace the passkey'}
            </Button>
          </form>
        </details>
      </CardContent>
    </Card>
  );
}

/**
 * Announces the passkey wait. Empty while idle but mounted, since a live region
 * must exist before a change to it is announced.
 */
function Ceremony({ running }: { running: boolean }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="text-xs text-muted-foreground"
    >
      {running ? 'Waiting for your passkey. Your browser will ask.' : ''}
    </p>
  );
}

function Problem({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}
