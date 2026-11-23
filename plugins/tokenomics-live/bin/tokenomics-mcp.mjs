#!/usr/bin/env node
// tokenomics-mcp: the MCP server Tokenomics gives the agents of a run (stdio, one JSON-RPC message per line).
// It holds no logic: every tool call is posted to the local Tokenomics core, which answers for the run.
//   TOKENOMICS_RUN        the run this agent belongs to
//   TOKENOMICS_RUN_TOKEN  that run's token (its MCP routes only; it cannot act for the user)
//   TOKENOMICS_AGENT      which of the run's agents this is
//   TOKENOMICS_MCP_TOOLS  "approve": the permission-prompt tool of a run's worker
//                         "chief":   the Chief of staff's tools (start sessions, wait, push when asked, report)
//   TOKENOMICS_PORT       the core's port (default 23821)
import http from 'node:http';
import { createInterface } from 'node:readline';

const { TOKENOMICS_RUN: run = '', TOKENOMICS_RUN_TOKEN: token = '', TOKENOMICS_AGENT: agent = '', TOKENOMICS_MCP_TOOLS: mode = 'approve' } = process.env;
const port = Number(process.env.TOKENOMICS_PORT) || 23821;

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const TOOLS = {
  approve: [{
    name: 'approve',
    description: 'Asks the person running this Tokenomics run whether a tool call may go ahead.',
    inputSchema: { type: 'object', properties: { tool_name: str('The tool asking for permission'), input: { type: 'object', description: 'Its input' }, tool_use_id: str('The tool call id') }, required: ['tool_name', 'input'] },
  }],
  chief: [
    { name: 'sessions_list', description: 'Lists the sessions and pairs this run has started: id, title, state, cost, and what each needs.', inputSchema: { type: 'object', properties: {} } },
    { name: 'session_start', description: 'Starts one agent session on a self-contained job and returns its id at once. Use for docs, notes, research, simple checks, or a contained fix. It works without asking the user; it cannot push or merge.',
      inputSchema: { type: 'object', properties: {
        title: str('A few words naming the job'), prompt: str('The whole job, self-contained: the session knows nothing else'),
        model: str('Optional model name. Leave out for the run’s default; use a small model for easy jobs.'),
        cli: str('Optional: claude, codex or copilot', { enum: ['claude', 'codex', 'copilot'] }),
        write: { type: 'boolean', description: 'true when the job changes files (default false: read-only)' },
        worktree: str('Optional branch name: the session works in its own git worktree on this new branch. Use it for every job that writes while another job also writes.'),
      }, required: ['title', 'prompt'] } },
    { name: 'pair_start', description: 'Starts a Pair on a code change (an author builds, a reviewer checks its diff and runs the tests, up to a few rounds) and returns its id at once. Use for any change that should be reviewed.',
      inputSchema: { type: 'object', properties: {
        title: str('A few words naming the job'), prompt: str('The goal: the outcome wanted, not the steps'),
        checks: { type: 'array', items: { type: 'string' }, description: 'Optional "done when" checks the reviewer holds the work to' },
        rounds: { type: 'integer', minimum: 1, maximum: 6, description: 'Most review rounds (default 3)' },
        worktree: str('Optional branch name: the pair works in its own git worktree on this new branch'),
      }, required: ['title', 'prompt'] } },
    { name: 'session_followup', description: 'Sends another prompt to a session or pair that has finished or stopped. It keeps its context.', inputSchema: { type: 'object', properties: { id: str('The id from session_start or pair_start'), prompt: str('What to do next') }, required: ['id', 'prompt'] } },
    { name: 'session_wait', description: 'Waits until one of the run’s sessions finishes, fails or needs the user (or a few minutes pass), then returns every session’s state. Call it again to keep waiting.', inputSchema: { type: 'object', properties: { seconds: { type: 'integer', minimum: 5, maximum: 240, description: 'Longest wait (default 240)' } } } },
    { name: 'session_status', description: 'One session or pair in detail: its state, its last reply, what it changed, what it cost.', inputSchema: { type: 'object', properties: { id: str('The id') }, required: ['id'] } },
    { name: 'git_push', description: 'Pushes when the USER has asked you to push (and, if they asked, merges sessions’ branches into the checkout’s branch first). The user confirms it in Tokenomics before anything happens; nothing is ever forced. Never call it for a push the user did not ask for.',
      inputSchema: { type: 'object', properties: {
        user_request: str('The user’s own words asking for the push'),
        merge: { type: 'array', items: { type: 'string' }, description: 'Optional ids of sessions whose branches to merge into the checkout’s branch before pushing' },
        branch: str('Optional: the branch to push. Leave out for the checkout’s current branch.'),
        remote: str('Optional: the remote (default origin)'),
      }, required: ['user_request'] } },
    { name: 'run_report', description: 'Files the report the user reads when the jobs are over: what is done and what needs them. Call it once, last.',
      inputSchema: { type: 'object', properties: { summary: str('Two or three sentences'), done: { type: 'array', items: { type: 'string' } }, needs_user: { type: 'array', items: { type: 'string' } } }, required: ['summary'] } },
  ],
};
const tools = TOOLS[mode] || TOOLS.approve;

function call(tool, args) {
  return new Promise(resolve => {
    const body = JSON.stringify({ run, agent, args });
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: `/api/runs/mcp/${tool}`, agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Tokenomics': '1', Authorization: `Bearer ${token}` },
    }, res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', c => { out += c; });
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(out); } catch { /* not JSON: an error below */ }
        if (res.statusCode === 200 && typeof data.text === 'string') resolve({ text: data.text });
        else resolve({ error: data.message || data.error || `Tokenomics answered ${res.statusCode}` });
      });
      res.on('error', e => resolve({ error: e.message }));
    });
    // A permission waits for a person (nine minutes, and a push after it may take two more); the core gives up before this does.
    req.setTimeout(700_000, () => { req.destroy(); resolve({ error: 'Tokenomics did not answer in time.' }); });
    req.on('error', e => resolve({ error: e.code === 'ECONNREFUSED' ? 'Tokenomics is not running.' : e.message }));
    req.end(body);
  });
}

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tokenomics', version: '1' } } });
  }
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools } });
  if (method === 'tools/call') {
    const name = params?.name;
    if (!tools.some(t => t.name === name)) return send({ id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    const out = await call(name, params?.arguments || {});
    // A permission the core could not answer is a denial, never an error the CLI might read as consent.
    if (name === 'approve' && out.error) return send({ id, result: { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: out.error }) }] } });
    return send({ id, result: { content: [{ type: 'text', text: out.error || out.text }], ...(out.error ? { isError: true } : {}) } });
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } }); // notifications need no answer
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg && typeof msg === 'object' && typeof msg.method === 'string') handle(msg).catch(e => { if (msg.id !== undefined) send({ id: msg.id, error: { code: -32603, message: e.message } }); });
}).on('close', () => process.exit(0));
