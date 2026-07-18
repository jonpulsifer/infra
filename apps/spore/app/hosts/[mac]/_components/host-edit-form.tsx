'use client';

import { useRouter } from 'next/navigation';
import { EntityForm } from '@/components/entity-form';
import { deleteHost, updateHost } from '@/lib/actions';
import type { Host, Profile } from '@/lib/db/schema';

interface HostEditFormProps {
  host: Host;
  profiles: Profile[];
}

export function HostEditForm({ host, profiles }: HostEditFormProps) {
  const router = useRouter();

  return (
    <EntityForm
      sections={[
        {
          card: false,
          fields: [
            {
              type: 'text',
              name: 'macAddress',
              label: 'MAC Address',
              defaultValue: host.macAddress,
              disabled: true,
              className: 'font-mono',
            },
            {
              type: 'text',
              name: 'hostname',
              label: 'Hostname',
              defaultValue: host.hostname || '',
              placeholder: 'k8s-node-1',
              helpText: 'Available as {{hostname}} in boot scripts',
            },
            {
              type: 'select',
              name: 'profileId',
              label: 'Boot Profile',
              defaultValue: host.profileId?.toString() || 'none',
              options: [
                { value: 'none', label: 'Default Menu' },
                ...profiles.map((profile) => ({
                  value: profile.id.toString(),
                  label: profile.isDefault
                    ? `${profile.name} (Default)`
                    : profile.name,
                })),
              ],
            },
          ],
        },
      ]}
      onSubmit={async (formData) => {
        const hostname = formData.get('hostname') as string;
        const profileId = formData.get('profileId') as string;

        await updateHost(host.macAddress, {
          hostname: hostname || null,
          profileId:
            profileId && profileId !== 'none'
              ? Number.parseInt(profileId, 10)
              : null,
        });
      }}
      onSubmitted={() => router.refresh()}
      onDelete={async () => {
        await deleteHost(host.macAddress);
        router.push('/hosts');
      }}
      deleteLabel="Delete Host"
      deleteConfirmMessage={`Delete host ${host.hostname || host.macAddress}? This cannot be undone.`}
    />
  );
}
