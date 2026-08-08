/**
 * The front door (Task 37, §"First run and identity").
 *
 * One screen with two states, not two screens. Which one an operator sees is a
 * fact about the installation rather than a choice they make: an installation
 * nobody has claimed shows enrolment, and one somebody has shows sign-in. There
 * is no toggle between them, because offering "enrol instead" on a claimed
 * installation would be offering something that always fails.
 *
 * §"First run" gives this screen its whole copy deck. Story 1 says the token
 * "shipped with the installation", so the field says where to find it rather
 * than just asking for it; story 2's consumption is why enrolment disappears
 * afterwards; and story 4's recovery — rotate the token, replace every passkey
 * — is the sentence under a sign-in that has stopped working, because that is
 * the moment somebody needs it.
 *
 * **It says which installation this is, and it says it with the origin.** This
 * is the first thing a human ever sees of the product and it identified
 * nothing, so staging and production were the same screen. The manifest holds
 * an `installation.name`, and nothing here can read it: this side of the door
 * has no session, and a control plane that told an anonymous caller what it is
 * called would be answering a question nobody authenticated to ask. The origin
 * is the honest identity available here — a ceremony is scoped to
 * `controlPlane.hostname` and a browser refuses one whose relying party is not
 * a suffix of the host in the address bar, so the host **is** what the passkey
 * is about to be bound to.
 *
 * **What it does, in one sentence, instead of what it is made of.** "Passkey
 * Authentication & UI-Driven Manifest Operations" is the vocabulary of the
 * implementation, and "manifest operations" is the noun this product exists to
 * hide from the person reading it.
 */
import { KeyRound, ShieldCheck } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { Principal } from '../../../commands/types.ts';
import { CeremonyAbandonedError, enrol, signIn } from '../../auth-client.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { Field } from '../../ui/field.tsx';

export interface GateProps {
  /**
   * Whether anybody has enrolled here yet. Decides which of the two states
   * renders, and comes from the server rather than from a guess.
   */
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
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center gap-6 px-5 py-12">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="font-mono text-xl font-bold tracking-[0.25em] text-foreground">
          SPINDRIFT
        </span>
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
  );
}

/**
 * Which installation the passkey is about to be bound to.
 *
 * Rendered as nothing when there is no origin to read — this file is also
 * rendered to static markup in a test, and a screen that invented a hostname
 * for that would be the one thing worse than a screen that names none.
 */
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
        // The server's own sentence, not one composed here — every refusal in
        // `src/auth/types.ts` carries the message its reader needs.
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
            // The first control a human ever meets in this product. It was not
            // focused, so the first act was a mouse hunt for the only box on
            // the screen — and this screen has exactly one.
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
 * That the browser is waiting on a passkey, out loud.
 *
 * The only sign a ceremony was in flight was a button label, which is announced
 * to nobody — and this ceremony can sit for thirty seconds while an operator
 * looks for a security key. Empty rather than unmounted while idle, so the
 * region exists before it has anything to say and the change is what is
 * announced.
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
    <p role="alert" className="text-sm text-terminal-destructive">
      {children}
    </p>
  );
}
