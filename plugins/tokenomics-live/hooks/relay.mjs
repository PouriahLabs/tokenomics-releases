// Forwards one Claude Code hook event (JSON on stdin) to the Tokenomics app and prints its reply.
// When the app isn't running it prints nothing and exits 0, so Claude Code shows no hook error
// (an "http" hook that can't connect is reported on every tool call). Only for PermissionRequest
// does the reply matter: a held prompt's decision, or nothing to let Claude Code ask as usual.
// Usage: node relay.mjs [permission]
const URL = process.env.TOKENOMICS_HOOK_URL || 'http://127.0.0.1:53821/hooks';
const permission = process.argv[2] === 'permission';

let body = '';
for await (const chunk of process.stdin) body += chunk;

try {
  const res = await fetch(URL, {
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
} catch {
  // App not running, timed out or refused: stay silent.
}
process.exit(0);
