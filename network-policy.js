import { isIP } from 'node:net';

export const defaultHosts = [
  'memorim.github.io',
  'memorim-flowboard-live.amusedcorgi34.chatgpt.site',
];
export const allowedHosts = () =>
  new Set(
    (process.env.MONITOR_ALLOWED_HOSTS || defaultHosts.join(','))
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
export function targetUrl(value, hosts = allowedHosts()) {
  const url = new URL(value.includes('://') ? value : 'https://' + value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) ||
    !hosts.has(url.hostname.toLowerCase())
  )
    throw new Error(
      'Разрешены HTTP/HTTPS-адреса настроенных владельцем доменов, без пароля и параметров',
    );
  return url;
}
export function publicAddress(address) {
  if (isIP(address) === 6) {
    const normalized = new URL('https://[' + address + ']/').hostname.slice(1, -1),
      parts = normalized.split(':'),
      first = parseInt(parts[0], 16),
      second = parseInt(parts[1] || '0', 16);
    // Conservative policy: transition, documentation and IETF protocol-assignment ranges are not monitoring targets.
    return (
      first >= 0x2000 &&
      first < 0x4000 &&
      !(first === 0x2001 && (second < 0x0200 || second === 0x0db8)) &&
      first !== 0x2002 &&
      !(first === 0x3fff && second < 0x1000)
    );
  }
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
