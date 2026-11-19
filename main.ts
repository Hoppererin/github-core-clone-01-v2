// Entry lifecycle: bind an ephemeral port, register it with the trial env,
// poll until the env says done, then exit 0. Without an env URL the server
// simply runs standalone (handy for local practice runs).
import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const PORT = Number(process.env.PORT ?? '0') || 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<void> {
  const url = `${envUrl.replace(/\/+$/, '')}/register`;
  let delay = 250;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      await sleep(delay);
      delay = Math.min(2000, delay * 2);
      continue;
    }
    if (res.status === 200 || res.status === 409) return;
    if (res.status === 400 || res.status === 405) {
      throw new Error(`register rejected with HTTP ${res.status}`);
    }
    await sleep(delay);
    delay = Math.min(2000, delay * 2);
  }
}

async function waitDone(envUrl: string): Promise<void> {
  const url = `${envUrl.replace(/\/+$/, '')}/done`;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env may not be up yet; keep polling.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(PORT, '0.0.0.0', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : PORT;
  console.log(`forge listening on ${port}`);

  if (ENV_URL === '') {
    console.log('MAKEFUN_ENV_URL is unset; running standalone');
    const shutdown = (): void => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  await register(ENV_URL, port);
  await waitDone(ENV_URL);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
