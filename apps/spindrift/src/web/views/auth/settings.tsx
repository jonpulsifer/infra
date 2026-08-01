import { KeyRound, Link, Link2Off, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { CredentialSettings } from '../../../auth/credential-admin.ts';
import {
  addPasskey,
  CeremonyAbandonedError,
  linkGateway,
  readCredentialSettings,
  removePasskey,
  unlinkGateway,
} from '../../auth-client.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { InstallationSettings } from './installation.tsx';

type CredentialAction =
  | { readonly kind: 'add' }
  | { readonly kind: 'gateway' }
  | { readonly kind: 'remove'; readonly credentialId: string };

export function Settings() {
  const [settings, setSettings] = useState<CredentialSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<CredentialAction | null>(null);

  const refresh = useCallback(async () => {
    setSettings(await readCredentialSettings());
  }, []);

  useEffect(() => {
    void refresh().catch(() =>
      setError('Credential settings could not be loaded.'),
    );
  }, [refresh]);

  const change = async (
    actionName: CredentialAction,
    action: () => ReturnType<typeof addPasskey>,
  ) => {
    setError(null);
    setRunning(actionName);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.failure.message);
        return;
      }
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof CeremonyAbandonedError
          ? 'No passkey was offered. This change was not made.'
          : 'Credential settings could not be changed.',
      );
    } finally {
      setRunning(null);
    }
  };

  if (settings === null) {
    return (
      <main className="mx-auto w-full max-w-[760px] px-5 py-8">
        <p className="text-sm text-muted-foreground">
          Loading platform & credential settings…
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-5 py-8">
      <InstallationSettings />
      <CredentialSettingsView
        settings={settings}
        error={error}
        running={running}
        onAdd={() => change({ kind: 'add' }, addPasskey)}
        onRemove={(credentialId) =>
          change({ kind: 'remove', credentialId }, () =>
            removePasskey(credentialId),
          )
        }
        onLink={() => change({ kind: 'gateway' }, linkGateway)}
        onUnlink={() => change({ kind: 'gateway' }, unlinkGateway)}
      />
    </main>
  );
}

export function CredentialSettingsView({
  settings,
  error,
  running,
  onAdd,
  onRemove,
  onLink,
  onUnlink,
}: {
  readonly settings: CredentialSettings;
  readonly error: string | null;
  readonly running: CredentialAction | null;
  readonly onAdd: () => void;
  readonly onRemove: (credentialId: string) => void;
  readonly onLink: () => void;
  readonly onUnlink: () => void;
}) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Operator credentials
        </h2>
        <p className="text-sm text-muted-foreground">
          Passkey root identity and Gateway assertions. Every change requires a
          fresh assertion from an enrolled passkey.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-terminal-destructive">
          {error}
        </p>
      )}

      {/* Account Passkeys */}
      <Card>
        <CardHeader>
          <KeyRound aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
          <div>
            <CardTitle>Passkeys</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Passkeys are the account root. At least one always remains.
            </p>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="divide-y divide-border">
            {settings.passkeys.map((passkey, index) => (
              <li
                key={passkey.credentialId}
                className="flex items-center gap-3 py-3 first:pt-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs text-foreground">
                    Passkey {index + 1} ·{' '}
                    {shortCredential(passkey.credentialId)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Added {new Date(passkey.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={
                    settings.passkeys.length === 1 ||
                    (running?.kind === 'remove' &&
                      running.credentialId === passkey.credentialId)
                  }
                  title={
                    settings.passkeys.length === 1
                      ? 'The final passkey cannot be removed'
                      : 'Remove passkey'
                  }
                  onClick={() => onRemove(passkey.credentialId)}
                >
                  <Trash2 aria-hidden="true" />
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <Button
            className="self-start"
            variant="outline"
            disabled={running !== null}
            onClick={onAdd}
          >
            <KeyRound aria-hidden="true" />
            {running?.kind === 'add'
              ? 'Waiting for passkeys…'
              : 'Add a passkey'}
          </Button>
        </CardContent>
      </Card>

      {/* Gateway identity */}
      <Card>
        <CardHeader>
          {settings.gatewayLinked ? (
            <Link aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
          ) : (
            <Link2Off
              aria-hidden="true"
              className="mt-0.5 size-4 text-subtle"
            />
          )}
          <div>
            <CardTitle>Gateway identity</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {settings.gatewayLinked
                ? 'A trusted Gateway assertion is linked to this operator.'
                : 'No Gateway identity is linked.'}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {settings.gatewayAvailable ? (
            <Button
              variant="outline"
              disabled={running !== null}
              onClick={settings.gatewayLinked ? onUnlink : onLink}
            >
              {settings.gatewayLinked ? (
                <Link2Off aria-hidden="true" />
              ) : (
                <Link aria-hidden="true" />
              )}
              {running?.kind === 'gateway'
                ? 'Waiting for a passkey…'
                : settings.gatewayLinked
                  ? 'Unlink Gateway identity'
                  : 'Link this Gateway identity'}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              No authenticated Gateway adapter is configured for this
              installation.
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function shortCredential(credentialId: string): string {
  return credentialId.length <= 14
    ? credentialId
    : `${credentialId.slice(0, 7)}…${credentialId.slice(-6)}`;
}
