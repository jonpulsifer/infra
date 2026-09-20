import Dashboard from '~/components/dashboard';

export function meta() {
  return [
    { title: 'Weather Hub' },
    {
      name: 'description',
      content:
        'Live conditions and the last 24 hours from the TempestWx stations.',
    },
  ];
}

export default function Home() {
  return <Dashboard />;
}
