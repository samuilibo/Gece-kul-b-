// Obtains a YouTube OAuth refresh token with the loopback flow (run once, on your PC).
// 1. Google Cloud Console -> Credentials -> Create OAuth client ID -> "Desktop app".
// 2. Put YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET in .env
// 3. node tools/oauth.mjs   -> open the printed URL, sign in with the channel account, allow read-only access.
// 4. Copy the printed refresh token into .env as YOUTUBE_OAUTH_REFRESH_TOKEN.
import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';

const id = process.env.YOUTUBE_OAUTH_CLIENT_ID, secret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
if (!id || !secret) { console.error('Set YOUTUBE_OAUTH_CLIENT_ID and YOUTUBE_OAUTH_CLIENT_SECRET in .env first.'); process.exit(1); }
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('hex');
const srv = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
  if (u.searchParams.get('state') !== state) { res.writeHead(400).end('state mismatch'); return; }
  const code = u.searchParams.get('code');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const j = await r.json();
  if (!j.refresh_token) { res.end('No refresh token received - see console.'); console.error(j); process.exit(1); }
  res.end('Done. You can close this tab and return to the console.');
  console.log('\nYOUTUBE_OAUTH_REFRESH_TOKEN=' + j.refresh_token + '\n\nPaste this line into .env (keep it secret).');
  srv.close();
});
let redirect = '';
srv.listen(0, '127.0.0.1', () => {
  redirect = `http://127.0.0.1:${srv.address().port}/callback`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: id, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/youtube.readonly', state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  console.log('Open this URL in your browser:\n\n' + auth.toString() + '\n');
});
