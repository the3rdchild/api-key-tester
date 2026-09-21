// Variables set by scripts during this session (bru.setVar).
//
// Kept in memory next to the response registry, and for the same reason: what
// scripts stash here is usually a freshly minted token. Environment variables
// are the durable half - those go back into collections.json.

import type { VarLookup } from './vars.ts';

const runtime = new Map<string, string>();

export function setRuntimeVars(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) runtime.set(k, v);
}

export function allRuntimeVars(): Record<string, string> {
  return Object.fromEntries(runtime);
}

export function runtimeLookup(): VarLookup {
  return (name) => runtime.get(name);
}
