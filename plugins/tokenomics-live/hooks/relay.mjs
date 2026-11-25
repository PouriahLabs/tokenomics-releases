// Forwards one Claude Code hook event (JSON on stdin) to the Tokenomics app and prints its reply.
// When the app isn't running it prints nothing and exits 0, so Claude Code shows no hook error
// (an "http" hook that can't connect is reported on every tool call). Only for PermissionRequest
// does the reply matter: a held prompt's decision, or nothing to let Claude Code ask as usual.
// Usage: node relay.mjs [permission]
// The app listens on 23821; one from before the port moved listens on 53821 only.
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const URLS = process.env.TOKENOMICS_HOOK_URL
  ? [process.env.TOKENOMICS_HOOK_URL]
  : ['http://127.0.0.1:23821/hooks', 'http://127.0.0.1:53821/hooks'];
const permission = process.argv[2] === 'permission';

// Loopback ports are not per user. The app keeps a key only this account can read (src/hook-auth.js):
// an event goes only to a listener that proves it holds the key, and a reply counts only when signed
// with it. No key yet (an app from before it, or never started): send as before, unverified.
const KEY = (() => {
  try {
    const s = readFileSync(join(process.env.TOKENOMICS_HOME_OVERRIDE || homedir(), '.claude', 'tokenomics', 'hook.key'), 'utf8').trim();
    return /^[a-f0-9]{64}$/.test(s) ? s : null;
  } catch (_) { return null; }
})();
const mac = (...parts) => createHmac('sha256', KEY).update(parts.join('\n')).digest('hex');
const same = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// -> true when the listener at url holds the key.
async function proven(url, nonce) {
  try {
    const res = await fetch(`${url}/hello?nonce=${nonce}`, { signal: AbortSignal.timeout(2_000) });
    return res.ok && same((await res.json())?.proof, mac('tokenomics-hook-hello', nonce));
  } catch (_) { return false; }
}

// Whatever listens on the port answers, and loopback ports are not per user: pass on only the one
// reply the app ever gives, a PermissionRequest allow or deny. Nothing else (updatedInput, added
// context, a decision for another event) reaches Claude Code.
function decisionOnly(text) {
  let d;
  try { d = JSON.parse(text)?.hookSpecificOutput; } catch (_) { return ''; }
  if (d?.hookEventName !== 'PermissionRequest') return '';
  const b = d.decision?.behavior;
  if (b === 'allow') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  if (b === 'deny') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: String(d.decision.message ?? '').slice(0, 1000) } } });
  return '';
}

let body = '';
for await (const chunk of process.stdin) body += chunk;
const ptyId = process.env.TOKENOMICS_PTY_ID;
if (ptyId) {
  try {
    const event = JSON.parse(body);
    event.tokenomics_pty_id = ptyId;
    body = JSON.stringify(event);
  } catch (_) { /* leave the original payload for the core to validate */ }
}

for (const url of URLS) {
  const nonce = KEY ? randomBytes(16).toString('hex') : null;
  // Not the app (nothing there, or someone else's listener): the event never leaves; try the next port.
  if (nonce && !(await proven(url, nonce))) continue;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tokenomics': '1', ...(nonce ? { 'X-Tokenomics-Nonce': nonce } : {}) },
      body,
      // A held permission prompt waits for the user's answer in the app (up to 9 minutes).
      signal: AbortSignal.timeout(permission ? 600_000 : 3_000),
    });
    if (res.ok && permission) {
      const text = await res.text();
      const signed = !nonce || same(res.headers.get('x-tokenomics-proof'), mac('tokenomics-hook-reply', nonce, text));
      const out = signed ? decisionOnly(text) : '';
      if (out) process.stdout.write(out);
    }
    break; // Something answered: never send the same event to a second port.
  } catch (e) {
    // Timed out: the app has the event, stop. Otherwise nothing listens here (app not running,
    // or an older one): try the next port, and stay silent when there is none.
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') break;
  }
}
process.exit(0);
