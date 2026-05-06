import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'myauthservice — drop-in auth for your apps',
  description:
    'Hosted authentication: register, login, MFA, and JWTs your services can verify in 10 lines of code.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
