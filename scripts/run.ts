#!/usr/bin/env bun
// Run a collection (or one folder) from the command line.
//
//   bun scripts/run.ts Auth --env local --bail
//   bun scripts/run.ts --reporter junit --out report.xml
//
// Exits non-zero when anything failed, so CI can just look at the exit code.
// Runs standalone: it reads collections.json directly and never talks to the
// server, which means it works in a container with no panel running.

import { writeFile } from 'node:fs/promises';

import { loadCollections } from '../server/core/collections.ts';
import { runCollection, setRunEmitter } from '../server/core/collection-runner.ts';
import type { RunItemResult, RunSummary } from '../shared/collections.ts';

interface Args {
  target?: string;
  env?: string;
  requests: string[];
  reporter: 'pretty' | 'json' | 'junit';
  out?: string;
  delayMs?: number;
  bail: boolean;
  list: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { requests: [], reporter: 'pretty', bail: false, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? '';
    switch (a) {
      case '--env':
      case '-e':
        args.env = next();
        break;
      case '--request':
      case '-r':
        args.requests.push(next());
        break;
      case '--reporter':
        args.reporter = next() as Args['reporter'];
        break;
      case '--out':
      case '-o':
        args.out = next();
        break;
      case '--delay':
        args.delayMs = Number(next()) || 0;
        break;
      case '--bail':
      case '-b':
        args.bail = true;
        break;
      case '--list':
      case '-l':
        args.list = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (!a.startsWith('-') && !args.target) args.target = a;
    }
  }
  return args;
}

const USAGE = `
Run a collection from the command line.

  bun scripts/run.ts [folder] [options]

  folder                name or id of a folder; omit to run everything
  --env,     -e <name>  environment to use (default: the active one)
  --request, -r <name>  run just this request (repeatable)
  --reporter <kind>     pretty (default) | json | junit
  --out,     -o <file>  write the report to a file
  --delay <ms>          pause between requests
  --bail,    -b         stop at the first failure
  --list,    -l         show what is runnable and exit
`;

function icon(item: RunItemResult): string {
  if (item.skipped) return '–';
  return item.passed ? '✓' : '✗';
}

function prettyItem(item: RunItemResult): string {
  const head = `${icon(item)} ${item.method.padEnd(6)} ${item.name}`;
  if (item.skipped) return `${head}  (skipped)`;
  const status = item.error ? item.error : `${item.status} · ${item.latencyMs} ms`;
  const checks = item.checks.length
    ? `  [${item.checks.filter((c) => c.passed).length}/${item.checks.length} checks]`
    : '';
  const failures = item.checks
    .filter((c) => !c.passed)
    .map((c) => `\n    ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    .join('');
  return `${head}  ${status}${checks}${failures}`;
}

function junit(summary: RunSummary): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cases = summary.items
    .map((item) => {
      const time = ((item.latencyMs ?? 0) / 1000).toFixed(3);
      const name = esc(`${item.method} ${item.name}`);
      if (item.skipped) return `    <testcase name="${name}" time="0"><skipped/></testcase>`;
      const problems = [
        ...(item.error ? [item.error] : []),
        ...item.checks.filter((c) => !c.passed).map((c) => `${c.name}${c.detail ? ` — ${c.detail}` : ''}`),
      ];
      if (problems.length === 0) return `    <testcase name="${name}" time="${time}"/>`;
      return `    <testcase name="${name}" time="${time}">\n      <failure message="${esc(
        problems[0]!,
      )}">${esc(problems.join('\n'))}</failure>\n    </testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="keyway" tests="${summary.total}" failures="${summary.failed}" time="${(
    summary.durationMs / 1000
  ).toFixed(3)}">
  <testsuite name="${esc(summary.label)}" tests="${summary.total}" failures="${summary.failed}" skipped="${summary.skipped}" time="${(
    summary.durationMs / 1000
  ).toFixed(3)}">
${cases}
  </testsuite>
</testsuites>
`;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const file = await loadCollections();

if (args.list) {
  console.log('Folders:');
  for (const node of file.tree) {
    if (node.type !== 'folder') continue;
    console.log(`  ${node.name}  (${node.children?.length ?? 0} requests)  [${node.id}]`);
  }
  console.log('\nEnvironments:');
  for (const env of file.environments) {
    console.log(`  ${env.name}${env.id === file.activeEnvId ? ' (active)' : ''}  [${env.id}]`);
  }
  process.exit(0);
}

// Names are friendlier than ids on a command line; ids still work.
const folder = args.target
  ? file.tree.find(
      (n) =>
        n.type === 'folder' &&
        (n.id === args.target || n.name?.toLowerCase() === args.target!.toLowerCase()),
    )
  : undefined;
if (args.target && !folder) {
  console.error(`No folder called "${args.target}". Try --list.`);
  process.exit(2);
}

const env = args.env
  ? file.environments.find(
      (e) => e.id === args.env || e.name.toLowerCase() === args.env!.toLowerCase(),
    )
  : undefined;
if (args.env && !env) {
  console.error(`No environment called "${args.env}". Try --list.`);
  process.exit(2);
}

const requestIds = args.requests.length
  ? args.requests
      .map((ref) => {
        const hit = Object.values(file.requests).find(
          (r) => r.id === ref || r.name.toLowerCase() === ref.toLowerCase(),
        );
        if (!hit) {
          console.error(`No request called "${ref}". Try --list.`);
          process.exit(2);
        }
        return hit.id;
      })
      .filter(Boolean)
  : undefined;

if (args.reporter === 'pretty') {
  setRunEmitter((event) => {
    if (event.type === 'item') console.log(prettyItem(event.item));
  });
}

const summary = await runCollection({
  folderId: folder?.id,
  requestIds,
  envId: env?.id,
  delayMs: args.delayMs,
  stopOnFailure: args.bail,
});

const report =
  args.reporter === 'json'
    ? JSON.stringify(summary, null, 2)
    : args.reporter === 'junit'
      ? junit(summary)
      : `\n${summary.passed}/${summary.total} passed` +
        (summary.failed ? `, ${summary.failed} failed` : '') +
        (summary.skipped ? `, ${summary.skipped} skipped` : '') +
        ` in ${(summary.durationMs / 1000).toFixed(1)}s`;

if (args.out) {
  await writeFile(args.out, report.endsWith('\n') ? report : `${report}\n`, 'utf8');
  console.log(`Report written to ${args.out}`);
} else {
  console.log(report);
}

process.exit(summary.failed > 0 ? 1 : 0);
