import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1>404</h1>
        <p>This Hex thread does not exist.</p>
        <Link href="/">Return to the arena</Link>
      </div>
    </main>
  );
}
