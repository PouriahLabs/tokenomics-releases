#!/usr/bin/env node
// tokenomics-hook: forwards a coding CLI's hook payload (JSON on stdin) to the local Tokenomics app.
//   node tokenomics-hook.mjs <provider> [event]
// provider: codex | copilot | gemini | cursor (Claude Code reports through the plugin's hooks/relay.mjs). event is the CLI's
// native hook name; it is added to the payload when the CLI doesn't include it.
// Silent and always exit 0: when the app isn't running, or answers with no decision, nothing is
// printed and the CLI carries on as if the hook were absent. A decision from the app (approve /
// deny) is printed as the hook's JSON response. Permission events wait up to 600 s for it; the
// rest give up after 5 s.
import http from 'node:http';

const [, , provider = 'claude', eventArg = ''] = process.argv;
// The app listens on 23821; one from before the port moved listens on 53821 only.
const PORTS = Number(process.env.TOKENOMICS_PORT) ? [Number(process.env.TOKENOMICS_PORT)] : [23821, 53821];
const DECISION_EVENTS = /^(PermissionRequest|permissionRequest|beforeShellExecution|beforeMCPExecution)$/;

const done = () => process.exit(0);

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    if (process.stdin.isTTY) resolve('');
  });
}

const raw = (await readStdin()).trim();
let payload = {};
try { payload = raw ? JSON.parse(raw) : {}; } catch { done(); }
if (!payload || typeof payload !== 'object' || Array.isArray(payload)) done();

const event = payload.hook_event_name ?? payload.hookEventName ?? payload.event ?? eventArg;
if (eventArg && !payload.hook_event_name && !payload.hookEventName && !payload.event) payload.hook_event_name = eventArg;
if (process.env.TOKENOMICS_PTY_ID) payload.tokenomics_pty_id = process.env.TOKENOMICS_PTY_ID;

const body = JSON.stringify(payload);
const timeout = DECISION_EVENTS.test(String(event)) ? 600_000 : 5_000;

function post(i) {
  const req = http.request({
    host: '127.0.0.1', port: PORTS[i], method: 'POST', path: `/hooks?provider=${encodeURIComponent(provider)}`, agent: false,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Tokenomics': '1' },
  }, res => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', c => { out += c; });
    res.on('end', () => {
      if (res.statusCode === 200 && out.trim()) process.stdout.write(out, done);
      else done();
    });
    res.on('error', done);
  });
  req.setTimeout(timeout, () => { req.destroy(); done(); });
  // Refused: nothing listens on this port, so try the next one. Any other failure ends it.
  req.on('error', e => (e?.code === 'ECONNREFUSED' && i + 1 < PORTS.length ? post(i + 1) : done()));
  req.end(body);
}
post(0);
