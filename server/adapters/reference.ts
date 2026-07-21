import type { TestResult } from '../../shared/types.ts';
import { type Adapter, errorState } from './types.ts';

// Catch-all for non-testable entries (claude-pro accounts, db passwords, app secrets).
// Stored in keys.md for reference / searchability but no Test button.
export const reference: Adapter = {
  id: 'reference',
  label: 'Reference (no test)',
  kind: 'reference',
  defaultSection: '--reference',
  fields: [
    { key: 'value', label: 'Value', type: 'textarea' },
  ],
  test: async () => {
    const result: TestResult = { state: 'error', detail: 'Reference entry — not testable' };
    return result;
  },
};

// ensure errorState is referenced for future extensions without import lint
void errorState;
