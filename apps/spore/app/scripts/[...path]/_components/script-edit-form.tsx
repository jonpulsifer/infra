'use client';

import { useRouter } from 'next/navigation';
import { EntityForm } from '@/components/entity-form';
import { deleteScript, updateScript } from '@/lib/actions';
import type { Script } from '@/lib/db/schema';

interface ScriptEditFormProps {
  script: Script;
}

export function ScriptEditForm({ script }: ScriptEditFormProps) {
  const router = useRouter();

  return (
    <EntityForm
      sections={[
        {
          title: 'Script Details',
          description: 'Edit script configuration',
          fields: [
            {
              type: 'text',
              name: 'path',
              label: 'Path',
              defaultValue: script.path,
              required: true,
              className: 'font-mono',
            },
            {
              type: 'text',
              name: 'description',
              label: 'Description (optional)',
              defaultValue: script.description || '',
            },
          ],
        },
        {
          title: 'Script Content',
          description: `iPXE script served at /api/scripts/${script.path}`,
          fields: [
            {
              type: 'textarea',
              name: 'content',
              label: 'Script Content',
              defaultValue: script.content,
              required: true,
              className: 'min-h-[400px] font-mono text-sm',
            },
          ],
        },
      ]}
      onSubmit={async (formData) => {
        const path = (formData.get('path') as string).replace(/^\/+/, '');
        const description = formData.get('description') as string;
        const content = formData.get('content') as string;

        await updateScript(script.id, {
          path,
          description: description || null,
          content,
        });
      }}
      onSubmitted={(formData) => {
        const path = (formData.get('path') as string).replace(/^\/+/, '');
        if (path !== script.path) {
          router.push(`/scripts/${path}`);
        } else {
          router.refresh();
        }
      }}
      onDelete={async () => {
        await deleteScript(script.id);
        router.push('/scripts');
      }}
      deleteLabel="Delete Script"
      deleteConfirmMessage={`Delete script "${script.path}"? This cannot be undone.`}
      cancelHref="/scripts"
    />
  );
}
