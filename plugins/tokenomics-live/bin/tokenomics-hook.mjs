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
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [, , provider = 'claude', eventArg = ''] = process.argv;
// The app listens on 23821; one from before the port moved listens on 53821 only.
const PORTS = Number(process.env.TOKENOMICS_PORT) ? [Number(process.env.TOKENOMICS_PORT)] : [23821, 53821];
const DECISION_EVENTS = /^(PermissionRequest|permissionRequest|beforeShellExecution|beforeMCPExecution)$/;

const done = () => process.exit(0);

// Whatever listens on the port answers, and loopback ports are not per user: pass on only the
// decision shapes the app sends (src/control.js, src/providers/hooks/*), rebuilt field by field.
// Rewritten tool input, added context or any other key never reaches the CLI.
const VERDICT = new Set(['allow', 'deny']);
const note = v => (typeof v === 'string' ? v.slice(0, 1000) : undefined);
function decisionOnly(text) {
  let d;
  try { d = JSON.parse(text); } catch { return ''; }
  if (!d || typeof d !== 'object') return '';
  let out = null;
  const h = d.hookSpecificOutput;
  if (h?.hookEventName === 'PermissionRequest' && VERDICT.has(h.decision?.behavior)) {
    out = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: h.decision.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: note(h.decision.message) ?? '' } } };
  } else if (VERDICT.has(d.permissionDecision) && d.behavior === d.permissionDecision) {
    out = { behavior: d.behavior, message: note(d.message), permissionDecision: d.permissionDecision, permissionDecisionReason: note(d.permissionDecisionReason) };
  } else if (VERDICT.has(d.permission)) {
    out = { permission: d.permission, userMessage: note(d.userMessage), agentMessage: note(d.agentMessage) };
  }
  return out ? JSON.stringify(out) : '';
}

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

// Loopback ports are not per user. The app keeps a key only this account can read (src/hook-auth.js):
// an event goes only to a listener that proves it holds the key, and a reply counts only when signed
// with it. No key yet (an app from before it, or never started): send as before, unverified.
const KEY = (() => {
  try {
    const s = readFileSync(join(process.env.TOKENOMICS_HOME_OVERRIDE || homedir(), '.claude', 'tokenomics', 'hook.key'), 'utf8').trim();
    return /^[a-f0-9]{64}$/.test(s) ? s : null;
  } catch { return null; }
})();
const mac = (...parts) => createHmac('sha256', KEY).update(parts.join('\n')).digest('hex');
const same = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// -> true when the listener on port holds the key.
function proven(port, nonce) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: `/hooks/hello?nonce=${nonce}`, agent: false }, res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (out.length < 4096) out += c; });
      res.on('end', () => { try { resolve(res.statusCode === 200 && same(JSON.parse(out)?.proof, mac('tokenomics-hook-hello', nonce))); } catch { resolve(false); } });
      res.on('error', () => resolve(false));
    });
    req.setTimeout(2_000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function post(i) {
  if (i >= PORTS.length) return done();
  const nonce = KEY ? randomBytes(16).toString('hex') : null;
  // Not the app (nothing there, or someone else's listener): the event never leaves; try the next port.
  if (nonce && !(await proven(PORTS[i], nonce))) return post(i + 1);
  const req = http.request({
    host: '127.0.0.1', port: PORTS[i], method: 'POST', path: `/hooks?provider=${encodeURIComponent(provider)}`, agent: false,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Tokenomics': '1', ...(nonce ? { 'X-Tokenomics-Nonce': nonce } : {}) },
  }, res => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', c => { out += c; });
    res.on('end', () => {
      const signed = !nonce || same(res.headers['x-tokenomics-proof'], mac('tokenomics-hook-reply', nonce, out));
      const verdict = res.statusCode === 200 && signed && DECISION_EVENTS.test(String(event)) ? decisionOnly(out) : '';
      if (verdict) process.stdout.write(verdict, done);
      else done();
    });
    res.on('error', done);
  });
  req.setTimeout(timeout, () => { req.destroy(); done(); });
  // Refused: nothing listens on this port, so try the next one. Any other failure ends it.
  req.on('error', e => (e?.code === 'ECONNREFUSED' ? post(i + 1) : done()));
  req.end(body);
}
post(0);
