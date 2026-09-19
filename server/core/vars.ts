// Variable interpolation for requests: {{name}} → value.
//
// A "lookup" is any function name → value. Sources are chained, first hit
// wins, so a send composes them as: runtime overrides → response chaining
// ({{res.…}}) → vault fields ({{vault.…}}) → active environment. Unknown names
// are left as-is so they stay visible in the UI instead of silently becoming
// an empty string.

import type { KV, RequestSpec } from '../../shared/collections.ts';

// Names may contain dots and spaces ({{res.Login.body.token}}), so anything
// but a closing brace is fair game.
const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

export type VarLookup = (name: string) => string | undefined;

export function fromRecord(vars: Record<string, string>): VarLookup {
  return (name) => (name in vars ? vars[name] : undefined);
}

export function chainLookups(...lookups: (VarLookup | undefined)[]): VarLookup {
  return (name) => {
    for (const lookup of lookups) {
      if (!lookup) continue;
      const hit = lookup(name);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
}

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

export function interpolate(input: string, lookup: VarLookup): Interpolation {
  const missing: string[] = [];
  const out = input.replace(TOKEN, (whole, name: string) => {
    const dyn = dynamic(name);
    if (dyn !== undefined) return dyn;
    const hit = lookup(name);
    if (hit !== undefined) return hit;
    missing.push(name);
    return whole;
  });
  return { out, missing };
}

function rows(list: KV[] | undefined, lookup: VarLookup, missing: Set<string>): KV[] {
  return (list ?? []).map((row) => {
    const k = interpolate(row.key, lookup);
    const v = interpolate(row.value, lookup);
    for (const m of [...k.missing, ...v.missing]) missing.add(m);
    return { ...row, key: k.out, value: v.out };
  });
}

/** Interpolate every user-editable string in a request. */
export function interpolateSpec(
  spec: RequestSpec,
  lookup: VarLookup,
): { spec: RequestSpec; missing: string[] } {
  const missing = new Set<string>();
  const url = interpolate(spec.url, lookup);
  for (const m of url.missing) missing.add(m);

  const body = { ...spec.body };
  if (body.text) {
    const t = interpolate(body.text, lookup);
    for (const m of t.missing) missing.add(m);
    body.text = t.out;
  }
  if (body.form) body.form = rows(body.form, lookup, missing);
  if (body.multipart) {
    body.multipart = body.multipart.map((row) => {
      if (row.type !== 'text') return row;
      const k = interpolate(row.key, lookup);
      const v = interpolate(row.value ?? '', lookup);
      for (const m of [...k.missing, ...v.missing]) missing.add(m);
      return { ...row, key: k.out, value: v.out };
    });
  }

  const auth = { ...spec.auth };
  for (const field of ['token', 'username', 'password', 'headerName', 'headerValue'] as const) {
    const raw = auth[field];
    if (typeof raw === 'string' && raw) {
      const r = interpolate(raw, lookup);
      for (const m of r.missing) missing.add(m);
      auth[field] = r.out;
    }
  }

  if (auth.oauth2) {
    const oauth = { ...auth.oauth2 };
    for (const field of [
      'authUrl',
      'tokenUrl',
      'deviceUrl',
      'clientId',
      'clientSecret',
      'scope',
      'audience',
      'username',
      'password',
      'redirectUri',
      'refreshToken',
    ] as const) {
      const raw = oauth[field];
      if (typeof raw === 'string' && raw) {
        const r = interpolate(raw, lookup);
        for (const m of r.missing) missing.add(m);
        oauth[field] = r.out;
      }
    }
    if (oauth.extraParams) oauth.extraParams = rows(oauth.extraParams, lookup, missing);
    auth.oauth2 = oauth;
  }

  return {
    spec: {
      ...spec,
      url: url.out,
      params: rows(spec.params, lookup, missing),
      headers: rows(spec.headers, lookup, missing),
      auth,
      body,
    },
    missing: [...missing],
  };
}
