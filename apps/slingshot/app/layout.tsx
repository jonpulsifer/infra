import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';
import { AppSidebar } from '@/components/app-sidebar';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Slingshot - Webhook Testing Platform',
  description:
    'Catch webhooks in the wild • Inspect, debug, and replay with ease',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <SidebarProvider defaultOpen={true}>
          {/*
            AppSidebar must precede SidebarInset. SidebarInset offsets itself
            with peer-data-* selectors, and Tailwind's `peer` only matches a
            preceding sibling - with the order reversed the inset got no offset
            and the fixed sidebar rendered on top of the page.
          */}
          <AppSidebar />
          <SidebarInset className="min-w-0 overflow-x-hidden">
            <div className="md:hidden sticky top-0 z-30 flex items-center gap-3 border-b border-border/60 bg-background/90 px-4 py-3 backdrop-blur">
              <SidebarTrigger />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-semibold text-foreground truncate">
                  Slingshot
                </span>
                <span className="text-xs text-muted-foreground truncate">
                  Webhook testing platform
                </span>
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col px-4 pb-6 pt-4 md:px-6 md:pt-6">
              {children}
            </div>
          </SidebarInset>
        </SidebarProvider>
        <Toaster position="top-right" richColors theme="dark" />
      </body>
    </html>
  );
}
