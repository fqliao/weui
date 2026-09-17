import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { assertAllowedUrl } from '../../websites/src/policy.ts';

// Playwright routes only the first request in an HTTP redirect chain. Enforce
// origin boundaries at the proxy as well, before any redirected connection.
export async function browserNetwork(baseUrl: string, origins: string[]) {
  const password = randomBytes(24).toString('hex');
  const agent = new http.Agent({ keepAlive: true });
  const authorization = `Basic ${Buffer.from(`weui:${password}`).toString('base64')}`;
  const sockets = new Set<Duplex>();
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  };
  const server = http.createServer((request, response) => {
    if (request.headers['proxy-authorization'] !== authorization) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="WeUI"' }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(assertAllowedUrl(request.url ?? '', baseUrl, origins));
      if (url.protocol !== 'http:') throw new Error('HTTP proxy requires absolute HTTP URL');
    } catch {
      response.writeHead(403).end('Website scope denied');
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request(url, { method: request.method, headers, agent }, (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    });
    upstream.on('socket', track);
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('connection', track);
  server.on('connect', (request, socket, head) => {
    if (request.headers['proxy-authorization'] !== authorization) {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="WeUI"\r\n\r\n',
      );
      return;
    }
    let url: URL;
    try {
      url = new URL(`https://${request.url}`);
      assertAllowedUrl(url.toString(), baseUrl, origins);
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = track(net.connect(Number(url.port || 443), url.hostname.replace(/^\[|\]$/g, '')));
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  return {
    proxy: {
      server: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
      username: 'weui',
      password,
    },
    close: () => {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
