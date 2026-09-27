// Opening a response compare from wherever the two responses are: the dialog
// lives in ClientView, while what's worth comparing — history entries, matrix
// cells, the response on screen — is spread over the sidebar, the matrix
// dialog and the response pane. An event carries it there, as import/export do.

import { clientApi } from '../lib/clientApi.ts';
import type { MatrixItem, ReqHistoryEntry, SendResult } from '../../../shared/collections.ts';

export interface CompareSide {
  label: string;
  /** where or when it came from */
  detail?: string;
  result: SendResult;
}

export interface CompareRequest {
  left: CompareSide;
  right: CompareSide;
}

export const COMPARE_EVENT = 'keyway:compare';

export function openCompare(left: CompareSide, right: CompareSide): void {
  window.dispatchEvent(new CustomEvent<CompareRequest>(COMPARE_EVENT, { detail: { left, right } }));
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** A history entry as one side: its stored response, fetched. */
export async function historySide(entry: ReqHistoryEntry): Promise<CompareSide> {
  const detail = await clientApi.historyDetail(entry.id);
  return {
    label: entry.name || `${entry.method} ${pathOf(entry.url)}`,
    detail: new Date(entry.ts).toLocaleString(),
    result: detail.result,
  };
}

/** A matrix cell as one side: its whole response, fetched from the server. */
export async function matrixSide(runId: string, item: MatrixItem): Promise<CompareSide> {
  const result = await clientApi.matrixCell(runId, item.id!);
  return { label: item.label, detail: item.model ? `model ${item.model}` : 'matrix cell', result };
}
