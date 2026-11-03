import { createHash, timingSafeEqual } from 'node:crypto';
// Local operator apps have no account boundary; a public reverse proxy must add authentication.
export function operatorBoundary(env = process.env) {
  let configured;
  if (env.APP_PUBLIC_ORIGIN) {
    configured = new URL(env.APP_PUBLIC_ORIGIN);
    if (
      !['https:', 'http:'].includes(configured.protocol) ||
      configured.username ||
      configured.password ||
      configured.pathname !== '/' ||
      configured.search ||
      configured.hash
    )
      throw new Error('APP_PUBLIC_ORIGIN must be an HTTP(S) origin');
  }
  const secret = env.APP_OPERATOR_TOKEN;
  if (configured && (!secret || secret.length < 32))
    throw new Error('Public access requires APP_OPERATOR_TOKEN of at least 32 characters');
  if (configured && configured.protocol !== 'https:')
    throw new Error('Public access requires an HTTPS origin');
  const hash = (value) => createHash('sha256').update(value).digest();
  return (req, res, next) => {
    let authority;
    try {
      authority = new URL(`http://${req.get('host') || ''}`);
      if (
        authority.username ||
        authority.password ||
        authority.pathname !== '/' ||
        authority.search ||
        authority.hash
      )
        throw new Error('Invalid host');
    } catch {
      return res.status(403).json({ message: 'Host is not allowed' });
    }
    const allowed = configured
      ? authority.host === configured.host
      : ['localhost', '127.0.0.1', '[::1]'].includes(authority.hostname);
    if (!allowed) return res.status(403).json({ message: 'Host is not allowed' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const expected = configured?.origin || `${req.protocol}://${authority.host}`;
      if (
        req.get('sec-fetch-site') === 'cross-site' ||
        (req.get('origin') && req.get('origin') !== expected)
      )
        return res.status(403).json({ message: 'Cross-origin writes are not allowed' });
    }
    if (configured) {
      const header = req.get('authorization') || '';
      let supplied = '';
      if (header.length <= 1024 && header.startsWith('Basic ')) {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        if (decoded.startsWith('operator:')) supplied = decoded.slice(9);
      }
      if (!timingSafeEqual(hash(supplied), hash(secret)))
        return res
          .set('WWW-Authenticate', 'Basic realm="Pulsewatch", charset="UTF-8"')
          .set('Cache-Control', 'no-store')
          .status(401)
          .json({ message: 'Authentication required' });
      res.set('Cache-Control', 'no-store');
    }
    next();
  };
}
