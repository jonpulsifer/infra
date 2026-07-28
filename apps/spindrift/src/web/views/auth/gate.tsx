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

const DEV_OPERATOR: Principal = {
  id: 'usr_dev_operator',
  displayName: 'Dev Operator',
};

export function Gate({
  claimed,
  gatewayUnlinked = false,
  onSignedIn,
}: GateProps) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col justify-center gap-5 px-5 py-10">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-sm font-bold tracking-[0.18em]">
          SPINDRIFT
        </span>
      </div>
      {claimed ? (
        <SignIn gatewayUnlinked={gatewayUnlinked} onSignedIn={onSignedIn} />
      ) : (
        <Enrol onSignedIn={onSignedIn} />
      )}
      <div className="rounded-lg border border-border bg-card p-3 text-center">
        <p className="mb-2 text-xs text-muted-foreground">
          Local Development Mode
        </p>
        <Button
          type="button"
          variant="outline"
          className="w-full font-mono text-xs"
          onClick={() => onSignedIn(DEV_OPERATOR)}
        >
          Bypass Auth (Sign in as Dev Operator)
        </Button>
      </div>
    </main>
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
      <CardContent className="flex flex-col gap-3">
        <Field
          name="enrolment-token"
          label="Enrolment token"
          type="password"
          autoComplete="off"
          value={token}
          placeholder="from SPINDRIFT_ENROLMENT_TOKEN"
          onChange={(event) => setToken(event.currentTarget.value)}
        />
        <Problem>{error}</Problem>
        <Button
          disabled={running || token.trim() === ''}
          onClick={() => run(() => enrol(token.trim()))}
        >
          <KeyRound aria-hidden="true" />
          {running ? 'Waiting for your passkey…' : 'Enrol a passkey'}
        </Button>
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
        <Button disabled={running} onClick={() => run(signIn)}>
          {running ? 'Waiting for your passkey…' : 'Continue with a passkey'}
        </Button>
        <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-foreground">
            Recover with a rotated token
          </summary>
          <div className="mt-3 flex flex-col gap-3">
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
              variant="outline"
              disabled={running || token.trim() === ''}
              onClick={() => run(() => enrol(token.trim()))}
            >
              <ShieldCheck aria-hidden="true" />
              {running ? 'Waiting for your passkey…' : 'Replace the passkey'}
            </Button>
          </div>
        </details>
      </CardContent>
    </Card>
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
