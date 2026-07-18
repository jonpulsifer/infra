'use client';

import { useRouter } from 'next/navigation';
import { EntityForm } from '@/components/entity-form';
import { deleteProfile, updateProfile } from '@/lib/actions';
import type { Profile } from '@/lib/db/schema';

interface ProfileEditFormProps {
  profile: Profile;
}

export function ProfileEditForm({ profile }: ProfileEditFormProps) {
  const router = useRouter();

  return (
    <EntityForm
      sections={[
        {
          title: 'Profile Details',
          description: 'Edit profile configuration',
          fields: [
            {
              type: 'text',
              name: 'name',
              label: 'Name',
              defaultValue: profile.name,
              required: true,
            },
            {
              type: 'text',
              name: 'description',
              label: 'Description (optional)',
              defaultValue: profile.description || '',
            },
            {
              type: 'switch',
              name: 'isDefault',
              label: 'Default Profile',
              description: 'Used for hosts without an assigned profile',
              defaultChecked: profile.isDefault || false,
            },
          ],
        },
        {
          title: 'iPXE Script',
          description: 'The boot script content served to hosts',
          fields: [
            {
              type: 'textarea',
              name: 'content',
              label: 'Script Content',
              defaultValue: profile.content,
              required: true,
              className: 'min-h-[400px] font-mono text-sm',
            },
          ],
        },
      ]}
      onSubmit={async (formData) => {
        const name = formData.get('name') as string;
        const description = formData.get('description') as string;
        const content = formData.get('content') as string;
        const isDefault = formData.get('isDefault') === 'on';

        await updateProfile(profile.id, {
          name,
          description: description || null,
          content,
          isDefault,
        });
      }}
      onSubmitted={() => router.refresh()}
      onDelete={async () => {
        await deleteProfile(profile.id);
        router.push('/profiles');
      }}
      deleteLabel="Delete Profile"
      deleteConfirmMessage={`Delete profile "${profile.name}"? Hosts using this profile will be unassigned.`}
      cancelHref="/profiles"
    />
  );
}
