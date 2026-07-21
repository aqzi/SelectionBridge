import * as http from 'node:http';

import type { PointerSnapshot } from './pointer';
import type { RegistryEntry } from './registry';

export interface PointerServer {
  port: number;
  dispose(): Promise<void>;
}

export interface PointerServerOptions {
  getToken(): string;
  getInstance(): RegistryEntry;
  getPointer(): PointerSnapshot;
}

export function startPointerServer(options: PointerServerOptions): Promise<PointerServer> {
  const server = http.createServer((request, response) => {
    handleRequest(options, request, response);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Pointer server did not bind to a TCP port.'));
        return;
      }

      resolve({
        port: address.port,
        dispose: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          })
      });
    });
  });
}

function handleRequest(
  options: PointerServerOptions,
  request: http.IncomingMessage,
  response: http.ServerResponse
): void {
  const url = new URL(request.url || '/', 'http://127.0.0.1');

  if (request.method !== 'GET') {
    writeJson(response, 405, {
      ok: false,
      error: { code: 'method_not_allowed', message: 'Only GET requests are supported.' }
    });
    return;
  }

  if (url.pathname === '/health') {
    const instance = options.getInstance();
    writeJson(response, 200, {
      ok: true,
      id: instance.id,
      updatedAt: instance.updatedAt
    });
    return;
  }

  if (!isAuthorized(request, options.getToken())) {
    writeJson(response, 401, {
      ok: false,
      error: { code: 'unauthorized', message: 'Missing or invalid Selection Bridge token.' }
    });
    return;
  }

  if (url.pathname === '/instance') {
    writeJson(response, 200, {
      ok: true,
      instance: withoutToken(options.getInstance())
    });
    return;
  }

  if (url.pathname === '/pointer') {
    writeJson(response, 200, {
      ok: true,
      instance: withoutToken(options.getInstance()),
      pointer: options.getPointer()
    });
    return;
  }

  writeJson(response, 404, {
    ok: false,
    error: { code: 'not_found', message: `Unknown route: ${url.pathname}` }
  });
}

function isAuthorized(request: http.IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function withoutToken(entry: RegistryEntry): Omit<RegistryEntry, 'token'> {
  const { token: _token, ...safeEntry } = entry;
  return safeEntry;
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}
