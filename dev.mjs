#!/usr/bin/env node
// Spawns both the Bun Hono server and the Vite dev server concurrently.
// Press Ctrl-C to kill both. Cross-platform.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const isWindows = process.platform === 'win32';
const cwd = import.meta.dirname;

// Detect bun via spawnSync. On Windows, prefer bun.exe (the bash shim "bun"
// can't be spawned by Node directly without a shell wrapper).
function hasBun() {
  const candidates = isWindows ? ['bun.exe', 'bun.cmd', 'bun'] : ['bun'];
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: false });
      if (r.status === 0 || r.error === undefined) {
        if (r.status === 0) {
          bunBin = cmd;
          return true;
        }
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

let bunBin = 'bun';

const useBun = hasBun();
if (!useBun) {
  console.error('This project requires Bun to run (server/index.ts uses Bun.serve + Bun WebSocket).');
  console.error('Install from https://bun.sh and re-run.');
  process.exit(1);
}

const procs = [];

function start(name, command, args, color, opts = {}) {
  const proc = spawn(command, args, {
    cwd: opts.cwd || cwd,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(proc);

  const prefix = `\x1b[${color}m[${name}]\x1b[0m`;
  const pipeStream = (stream) => {
    stream.on('data', (d) => {
      const text = d.toString();
      for (const line of text.split('\n')) {
        if (line.length === 0) continue;
        process.stdout.write(`${prefix} ${line}\n`);
      }
    });
  };
  pipeStream(proc.stdout);
  pipeStream(proc.stderr);
  proc.on('exit', (code) => {
    console.log(`${prefix} exited with code ${code}`);
  });
}

// Backend: bun --watch
start('api', bunBin, ['--watch', 'server/index.ts'], '36');

// Frontend: bun x vite (strictPort is set in vite.config.ts)
// Run from ui/ so vite picks up its config + index.html
start('ui', bunBin, ['x', 'vite'], '35', { cwd: resolve(cwd, 'ui') });

function shutdown() {
  console.log('\nshutting down…');
  for (const p of procs) {
    try {
      if (isWindows) {
        spawnSync('taskkill', ['/pid', String(p.pid), '/f', '/t'], { shell: true });
      } else {
        p.kill('SIGTERM');
      }
    } catch {}
  }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('dev mode - press Ctrl-C to stop');
console.log('  API → http://127.0.0.1:8788');
console.log('  UI  → http://localhost:5174');
