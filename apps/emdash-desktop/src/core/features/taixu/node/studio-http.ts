import http from 'node:http';
import type { Duplex } from 'node:stream';

/** A capability-scoped loopback proxy. SSH carries the stream; no public listener. */
export async function proxyStudioHttp(
  remoteUrl: string,
  open: (signal: AbortSignal) => Promise<Duplex>,
  sessionSignal: AbortSignal
) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/\?desktop=1$/.test(remoteUrl))
    throw new Error('Invalid Studio URL.');
  const remote = new URL(remoteUrl);
  let origin = '';
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    const fail = (code: number) => {
      if (!res.headersSent) res.writeHead(code);
      res.end();
    };
    if (
      req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin) ||
      !req.url?.startsWith(remote.pathname)
    )
      return fail(403);
    if (sessionSignal.aborted) return fail(503);
    const abort = new AbortController();
    const cancel = () => abort.abort();
    sessionSignal.addEventListener('abort', cancel, { once: true });
    res.once('close', cancel);
    let channel: Duplex | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(cancel, 240000);
      idle.unref();
    };
    try {
      channel = await open(abort.signal);
      if (abort.signal.aborted || sessionSignal.aborted) {
        channel.destroy();
        return fail(503);
      }
      const headers = { ...req.headers, host: remote.host };
      if (headers.origin) headers.origin = remote.origin;
      delete headers.connection;
      delete headers.upgrade;
      // Never forward a client-selected proxy destination or authorization header.
      delete headers['proxy-authorization'];
      const upstream = http.request(
        {
          hostname: remote.hostname,
          port: remote.port,
          path: req.url,
          method: req.method,
          headers,
          createConnection: () => channel!,
          signal: abort.signal,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.on('error', () => res.destroy());
          response.on('data', touch);
          response.pipe(res);
        }
      );
      upstream.on('error', () => fail(502));
      // ssh2 channels are Duplex streams, not net.Socket (no setTimeout).
      touch();
      req.on('error', cancel);
      req.pipe(upstream);
      await new Promise<void>((resolve) => res.once('close', resolve));
    } catch {
      fail(502);
    } finally {
      clearTimeout(idle);
      channel?.destroy();
      sessionSignal.removeEventListener('abort', cancel);
    }
  }
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not open Studio proxy.');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}${remote.pathname}${remote.search}`,
    async dispose() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
