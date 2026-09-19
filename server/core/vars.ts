// Variable interpolation for requests: {{name}} → value.
//
// Resolution order (first hit wins): runtime vars set during a run → active
// environment. Unknown names are left as-is so they stay visible in the UI
// instead of silently turning into an empty string.

import type { KV, RequestSpec } from '../../shared/collections.ts';

const TOKEN = /\{\{\s*([^}\s]+)\s*\}\}/g;

function dynamic(name: string): string | undefined {
  switch (name) {
    case '$timestamp':
      return String(Math.floor(Date.now() / 1000));
    case '$isoTimestamp':
      return new Date().toISOString();
    case '$uuid':
      return crypto.randomUUID();
    case '$randomInt':
      return String(Math.floor(Math.random() * 1000));
    default:
      return undefined;
  }
}

export interface Interpolation {
  out: string;
  missing: string[];
}

export function interpolate(input: string, vars: Record<string, string>): Interpolation {
  const missing: string[] = [];
  const out = input.replace(TOKEN, (whole, name: string) => {
    const dyn = dynamic(name);
    if (dyn !== undefined) return dyn;
    if (name in vars) return vars[name]!;
    missing.push(name);
    return whole;
  });
  return { out, missing };
}

function rows(list: KV[] | undefined, vars: Record<string, string>, missing: Set<string>): KV[] {
  return (list ?? []).map((row) => {
    const k = interpolate(row.key, vars);
    const v = interpolate(row.value, vars);
    for (const m of [...k.missing, ...v.missing]) missing.add(m);
    return { ...row, key: k.out, value: v.out };
  });
}

/** Interpolate every user-editable string in a request. */
export function interpolateSpec(
  spec: RequestSpec,
  vars: Record<string, string>,
): { spec: RequestSpec; missing: string[] } {
  const missing = new Set<string>();
  const url = interpolate(spec.url, vars);
  for (const m of url.missing) missing.add(m);

  const body = { ...spec.body };
  if (body.text) {
    const t = interpolate(body.text, vars);
    for (const m of t.missing) missing.add(m);
    body.text = t.out;
  }
  if (body.form) body.form = rows(body.form, vars, missing);
  if (body.multipart) {
    body.multipart = body.multipart.map((row) => {
      if (row.type !== 'text') return row;
      const k = interpolate(row.key, vars);
      const v = interpolate(row.value ?? '', vars);
      for (const m of [...k.missing, ...v.missing]) missing.add(m);
      return { ...row, key: k.out, value: v.out };
    });
  }

  const auth = { ...spec.auth };
  for (const field of ['token', 'username', 'password', 'headerName', 'headerValue'] as const) {
    const raw = auth[field];
    if (typeof raw === 'string' && raw) {
      const r = interpolate(raw, vars);
      for (const m of r.missing) missing.add(m);
      auth[field] = r.out;
    }
  }

  return {
    spec: {
      ...spec,
      url: url.out,
      params: rows(spec.params, vars, missing),
      headers: rows(spec.headers, vars, missing),
      auth,
      body,
    },
    missing: [...missing],
  };
}
