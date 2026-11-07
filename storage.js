import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
export function dataDirectory() {
  const directory = resolve(process.env.PULSEWATCH_DATA_DIRECTORY || resolve(root, 'data'));
  const publicDirectory = resolve(root, 'public');
  if (directory === publicDirectory || directory.startsWith(publicDirectory + '/'))
    throw new Error('Pulsewatch data must be outside the public directory');
  return directory;
}

export function listenHost(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !env.APP_PUBLIC_ORIGIN)
    throw new Error('External HOST requires authenticated APP_PUBLIC_ORIGIN');
  return host;
}
