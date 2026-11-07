import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Clips · Qorlla',
  description: 'Record, create and share short video clips with your team.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
