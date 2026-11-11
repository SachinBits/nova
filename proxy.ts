import { type NextRequest, NextResponse } from 'next/server';

// Hex is a local tool. When a tunnel (cloudflared, ngrok, ...) forwards traffic so GitHub can deliver
// webhooks, only the signed webhook endpoint answers remote requests; the app itself stays local.
// Set HEX_ALLOW_REMOTE=1 to serve everything remotely (for a deployment with its own access control).
export function proxy(request: NextRequest) {
  if (process.env.HEX_ALLOW_REMOTE === '1') return NextResponse.next();
  // Next.js adds x-forwarded-* itself, so their presence proves nothing. A request is local when every host it
  // names is loopback, every client address it names is loopback, and no tunnel-specific header is present.
  const loopbackHost = (value: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(value.trim());
  const loopbackAddress = (value: string) => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/i.test(value.trim());
  const hosts = [request.headers.get('host') ?? '', ...(request.headers.get('x-forwarded-host') ?? '').split(',').filter(Boolean)];
  const clients = (request.headers.get('x-forwarded-for') ?? '').split(',').filter((value) => value.trim());
  const tunnel = ['cf-connecting-ip', 'cf-ray', 'ngrok-trace-id', 'x-real-ip', 'forwarded'].some((name) => request.headers.has(name));
  const local = hosts.every(loopbackHost) && clients.every(loopbackAddress) && !tunnel;
  if (local) return NextResponse.next();
  if (request.method === 'POST' && request.nextUrl.pathname === '/api/github/webhook') return NextResponse.next();
  return new NextResponse('Not found', { status: 404 });
}

export const config = {
  matcher: '/:path*',
};
