import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata } from 'next';
import './globals.css';
import { Nav } from '@/components/nav';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Spore - iPXE Boot Manager',
  description: 'Observe Git-managed network-boot policy and activity',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} min-h-screen antialiased font-sans`}
      >
        <div className="flex min-h-screen flex-col md:flex-row">
          <Nav />
          <main className="min-w-0 flex-1 overflow-auto p-5 md:p-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
