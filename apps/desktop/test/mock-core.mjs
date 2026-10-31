#!/usr/bin/env node
// Minimal stand-in for the Python core (docs/CONTRACTS.md), used by unit and e2e tests via
// CHEF_CORE_CMD="node apps/desktop/test/mock-core.mjs".
// Implements: system.ping, system.shutdown, ops.run (fake job with progress notifications),
// jobs.cancel, and test helpers mock.crash / mock.echo / mock.sleep.
// Env: MOCK_CORE_STARTUP_DELAY_MS (delay before reading stdin), MOCK_CORE_EXIT_ON_START=<code>.
import readline from 'node:readline';

const argv = process.argv.slice(2);
const dataDirIdx = argv.indexOf('--data-dir');
const dataDir = dataDirIdx >= 0 ? argv[dataDirIdx + 1] : null;

if (process.env.MOCK_CORE_EXIT_ON_START) {
  process.stderr.write('mock-core: exiting on start as requested\n');
  process.exit(Number(process.env.MOCK_CORE_EXIT_ON_START));
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const notify = (method, params) => send({ method, params });
const jobs = new Map();
let nextJob = 1;

function fakeState(sessionId) {
  return {
    sessionId: sessionId ?? 'mock-session',
    sourcePath: null,
    revisionPath: dataDir ? `${dataDir}/sessions/mock/rev-0001.pdf` : '/tmp/rev-0001.pdf',
    revision: 1,
    canUndo: true,
    canRedo: false,
    dirty: true,
    signed: false,
  };
}

function runJob(jobId, params) {
  const total = 3;
  let done = 0;
  const tick = () => {
    const job = jobs.get(jobId);
    if (!job) return;
    if (job.cancelled) {
      jobs.delete(jobId);
      notify('job.cancelled', { jobId });
      return;
    }
    done++;
    notify('job.progress', { jobId, done, total, message: `step ${done}` });
    if (done < total) {
      job.timer = setTimeout(tick, 20);
      return;
    }
    jobs.delete(jobId);
    notify('job.finished', {
      jobId,
      result: {
        state: fakeState(params?.sessionId),
        changedPages: 'all',
        warnings: [],
        outputs: [],
        data: { echo: params?.params ?? null },
      },
    });
  };
  jobs.set(jobId, { cancelled: false, timer: setTimeout(tick, 20) });
}

const handlers = {
  'system.ping': () => ({ version: '0.0.0-mock', python: 'mock' }),
  'system.shutdown': () => {
    setTimeout(() => process.exit(0), 10);
    return null;
  },
  'ops.run': (params) => {
    if (!params || typeof params.opId !== 'string') {
      throw { code: -32602, message: 'opId is required', data: { kind: 'INVALID_PARAMS' } };
    }
    const jobId = `job-${nextJob++}`;
    runJob(jobId, params);
    return { jobId };
  },
  'jobs.cancel': (params) => {
    const job = jobs.get(params?.jobId);
    if (job) job.cancelled = true;
    return null;
  },
  'mock.echo': (params) => params,
  'mock.sleep': (params) => new Promise((r) => setTimeout(() => r(null), params?.ms ?? 1000)),
  'mock.crash': () => {
    process.stderr.write('mock-core: crashing on request\n');
    setTimeout(() => process.exit(3), 5);
    return null;
  },
  'mock.unicode': () => ({ text: 'Nghị định – tiếng Việt ✓' }),
};

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error', data: { kind: 'INTERNAL' } } });
    return;
  }
  const fn = handlers[msg.method];
  if (msg.id === undefined) return; // notifications from main: none expected
  if (!fn) {
    send({
      id: msg.id,
      error: {
        code: -32601,
        message: `Method not found: ${msg.method}`,
        data: { kind: 'OP_NOT_FOUND' },
      },
    });
    return;
  }
  try {
    const result = await fn(msg.params);
    send({ id: msg.id, result: result ?? null });
  } catch (err) {
    const e =
      err && typeof err.code === 'number'
        ? err
        : { code: -32000, message: String(err?.message ?? err), data: { kind: 'INTERNAL' } };
    send({ id: msg.id, error: e });
  }
}

function start() {
  process.stderr.write(`mock-core: started pid=${process.pid} data-dir=${dataDir}\n`);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (line.trim()) void handle(line);
  });
  rl.on('close', () => process.exit(0));
}

const delay = Number(process.env.MOCK_CORE_STARTUP_DELAY_MS || 0);
if (delay > 0) setTimeout(start, delay);
else start();
