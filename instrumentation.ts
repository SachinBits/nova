// Starts the GitHub push monitor (queue and poller) when the Node.js server boots.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startLive } = await import('./lib/server/live');
    startLive();
  }
}
