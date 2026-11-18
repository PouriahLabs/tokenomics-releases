// Forwards one Claude Code hook event (JSON on stdin) to the Tokenomics app and prints its reply.
// When the app isn't running it prints nothing and exits 0, so Claude Code shows no hook error
// (an "http" hook that can't connect is reported on every tool call). Only for PermissionRequest
// does the reply matter: a held prompt's decision, or nothing to let Claude Code ask as usual.
// Usage: node relay.mjs [permission]
// The app listens on 23821; one from before the port moved listens on 53821 only.
const URLS = process.env.TOKENOMICS_HOOK_URL
  ? [process.env.TOKENOMICS_HOOK_URL]
  : ['http://127.0.0.1:23821/hooks', 'http://127.0.0.1:53821/hooks'];
const permission = process.argv[2] === 'permission';

let body = '';
for await (const chunk of process.stdin) body += chunk;

for (const url of URLS) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tokenomics': '1' },
      body,
      // A held permission prompt waits for the user's answer in the app (up to 9 minutes).
      signal: AbortSignal.timeout(permission ? 600_000 : 3_000),
    });
    if (res.ok) {
      const text = await res.text();
      if (text.trim()) process.stdout.write(text);
    }
    break; // Something answered: never send the same event to a second port.
  } catch (e) {
    // Timed out: the app has the event, stop. Otherwise nothing listens here (app not running,
    // or an older one): try the next port, and stay silent when there is none.
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') break;
  }
}
process.exit(0);
