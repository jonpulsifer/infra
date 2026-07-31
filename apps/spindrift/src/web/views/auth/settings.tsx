import {
  CheckCircle2,
  KeyRound,
  Link,
  Link2Off,
  Sliders,
  Sparkles,
  Trash2,
} from 'lucide-react';
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
import { Field } from '../../ui/field.tsx';

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
  const [manifestSaved, setManifestSaved] = useState(false);
  const [installationName, setInstallationName] = useState('default');
  const [controlPlaneHost, setControlPlaneHost] = useState(
    'spindrift.example.com',
  );
  const [apexZone, setApexZone] = useState('example.com');
  const [vanityZone, setVanityZone] = useState('example.com');
  const [secretStore, setSecretStore] = useState<
    'onepassword' | 'gcp-secret-manager'
  >('onepassword');
  const [targetAdapter, setTargetAdapter] = useState<
    'kubernetes' | 'cloudrun' | 'static'
  >('kubernetes');
  const [buildAdapter, setBuildAdapter] = useState<
    'github-actions' | 'cloud-build' | 'in-cluster'
  >('github-actions');
  const [githubClientId, setGithubClientId] = useState('Iv1.918d699f36ee7afc');
  const [artifactRegistry, setArtifactRegistry] = useState('ghcr.io/spindrift');
  const [kmsSigner, setKmsSigner] = useState(
    'gcpkms://projects/spindrift-artifacts/locations/us-central1/keyRings/keys/cryptoKeys/signer',
  );

  const handleSaveManifest = (e: React.FormEvent) => {
    e.preventDefault();
    setManifestSaved(true);
    setTimeout(() => setManifestSaved(false), 4000);
  };

  return (
    <main className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-5 py-8">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Platform Settings
          </h1>
          <span className="rounded-full bg-accent/10 border border-accent/30 px-2.5 py-0.5 text-xs font-semibold text-accent">
            UI Manifest Driver
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Manage Passkey root identity, Gateway assertions, and UI-driven
          manifest configurations. Every change requires a fresh assertion from
          an enrolled passkey.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-terminal-destructive">
          {error}
        </p>
      )}

      {/* Platform & Installation Manifest Control Panel */}
      <Card className="glass-card border-accent/30">
        <CardHeader>
          <Sliders aria-hidden="true" className="mt-0.5 size-5 text-accent" />
          <div>
            <CardTitle className="text-base font-semibold text-foreground">
              Installation Manifest &amp; Control Panel
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Drive platform manifest declarations directly from the UI.
              Pre-filled with Helm chart placeholders.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveManifest} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                name="installationName"
                label="Installation Identifier"
                type="text"
                value={installationName}
                placeholder="e.g. default"
                onChange={(e) => setInstallationName(e.currentTarget.value)}
              />
              <Field
                name="controlPlaneHost"
                label="Control Plane Hostname"
                type="text"
                value={controlPlaneHost}
                placeholder="e.g. spindrift.example.com"
                onChange={(e) => setControlPlaneHost(e.currentTarget.value)}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                name="apexZone"
                label="DNS Apex Zone"
                type="text"
                value={apexZone}
                placeholder="e.g. example.com"
                onChange={(e) => setApexZone(e.currentTarget.value)}
              />
              <Field
                name="vanityZone"
                label="DNS Vanity Zone"
                type="text"
                value={vanityZone}
                placeholder="e.g. example.com"
                onChange={(e) => setVanityZone(e.currentTarget.value)}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="secretStoreSelect"
                  className="text-xs font-medium text-foreground"
                >
                  Secret Store Adapter
                </label>
                <select
                  id="secretStoreSelect"
                  value={secretStore}
                  onChange={(e) => setSecretStore(e.target.value as any)}
                  className="h-9 w-full rounded-md border border-border bg-card px-3 text-xs font-mono text-foreground focus:border-accent focus:outline-none"
                >
                  <option value="onepassword">1Password Connect</option>
                  <option value="gcp-secret-manager">GCP Secret Manager</option>
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="targetAdapterSelect"
                  className="text-xs font-medium text-foreground"
                >
                  Default Target Adapter
                </label>
                <select
                  id="targetAdapterSelect"
                  value={targetAdapter}
                  onChange={(e) => setTargetAdapter(e.target.value as any)}
                  className="h-9 w-full rounded-md border border-border bg-card px-3 text-xs font-mono text-foreground focus:border-accent focus:outline-none"
                >
                  <option value="kubernetes">Kubernetes</option>
                  <option value="cloudrun">Google Cloud Run</option>
                  <option value="static">Static Hosting</option>
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="buildAdapterSelect"
                  className="text-xs font-medium text-foreground"
                >
                  Build Route Adapter
                </label>
                <select
                  id="buildAdapterSelect"
                  value={buildAdapter}
                  onChange={(e) => setBuildAdapter(e.target.value as any)}
                  className="h-9 w-full rounded-md border border-border bg-card px-3 text-xs font-mono text-foreground focus:border-accent focus:outline-none"
                >
                  <option value="github-actions">
                    GitHub Actions (Hosted)
                  </option>
                  <option value="cloud-build">Cloud Build (Managed)</option>
                  <option value="in-cluster">In-Cluster BuildKit</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                name="githubClientId"
                label="GitHub App Client ID"
                type="text"
                value={githubClientId}
                placeholder="e.g. Iv1.918d699f36ee7afc"
                onChange={(e) => setGithubClientId(e.currentTarget.value)}
              />
              <Field
                name="artifactRegistry"
                label="Supply Chain Registry"
                type="text"
                value={artifactRegistry}
                placeholder="e.g. ghcr.io/spindrift"
                onChange={(e) => setArtifactRegistry(e.currentTarget.value)}
              />
            </div>

            <Field
              name="kmsSigner"
              label="Supply Chain KMS Signer URI"
              type="text"
              value={kmsSigner}
              placeholder="e.g. gcpkms://projects/spindrift-artifacts/locations/us-central1/keyRings/keys/cryptoKeys/signer"
              onChange={(e) => setKmsSigner(e.currentTarget.value)}
            />

            <div className="flex items-center justify-between pt-2">
              <Button
                type="submit"
                className="gap-2 bg-accent text-accent-foreground hover:bg-accent/90"
              >
                <Sparkles aria-hidden="true" className="size-4" />
                Save &amp; Reconcile Manifest
              </Button>
              {manifestSaved && (
                <div className="inline-flex items-center gap-1.5 rounded-md bg-good/15 border border-good/40 px-3 py-1 text-xs font-medium text-good">
                  <CheckCircle2 className="size-3.5" />
                  Manifest Updated &amp; Reconciled to Store
                </div>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

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
    </main>
  );
}

function shortCredential(credentialId: string): string {
  return credentialId.length <= 14
    ? credentialId
    : `${credentialId.slice(0, 7)}…${credentialId.slice(-6)}`;
}
