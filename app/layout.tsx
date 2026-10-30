import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Hex — Autonomous Security Arena',
  description: 'A live red team / blue team agent simulation',
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
