import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import http from 'node:http';
import { publicAddress } from './network-policy.js';

// Re-resolve and validate every hop, then pin the socket lookup. The URL hostname remains the TLS server name.
export async function pinnedRequest(
  url,
  {
    resolve = lookup,
    request,
    signal = new AbortController().signal,
    method = 'GET',
    headers = {},
    body,
  } = {},
) {
  signal.throwIfAborted();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  let abort, addresses;
  try {
    addresses = await Promise.race([
      resolve(url.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        abort = () => reject(deadline.reason);
        deadline.addEventListener('abort', abort, { once: true });
        if (deadline.aborted) abort();
      }),
    ]);
  } finally {
    deadline.removeEventListener('abort', abort);
  }
  if (
    !Array.isArray(addresses) ||
    !addresses.length ||
    addresses.some((a) => !a || !publicAddress(a.address) || isIP(a.address) !== a.family)
  )
    throw new Error('non_public_address');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const send = request || (url.protocol === 'https:' ? https.request : http.request);
    const req = send(
      url,
      {
        method,
        agent: false,
        family: selected.family,
        autoSelectFamily: false,
        lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        maxHeaderSize: 16384,
        headers: { 'User-Agent': 'Pulsewatch/2.1', Accept: '*/*', ...headers },
      },
      (res) => {
        const result = { code: res.statusCode, location: res.headers.location };
        // Only status/headers are needed; never buffer an untrusted response body.
        res.destroy();
        resolve(result);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
