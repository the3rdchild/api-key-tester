import {
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { TestResult } from '../../shared/types.ts';
import { type Adapter, errorState, valid } from './types.ts';

function classifyS3Error(e: unknown, latencyMs: number): TestResult {
  if (e instanceof S3ServiceException) {
    const name = e.name;
    const msg = `${name}: ${e.message}`;
    // include request id + http status + metadata for debugging
    const httpPart = e.$metadata?.httpStatusCode ? `\nHTTP ${e.$metadata.httpStatusCode}` : '';
    const reqPart = e.$metadata?.requestId ? `\nrequestId: ${e.$metadata.requestId}` : '';
    const raw = `${name}: ${e.message}${httpPart}${reqPart}\n${formatS3Meta(e)}`.trim();
    if (name === 'AccessDenied' || name === 'SignatureDoesNotMatch' || name === 'InvalidAccessKeyId') {
      return { state: 'invalid', latencyMs, detail: msg, raw };
    }
    if (name === 'NotFound' || name === 'NoSuchBucket') {
      return { state: 'invalid', latencyMs, detail: `Bucket not found: ${msg}`, raw };
    }
    if (name === 'PermanentRedirect' || name === 'BucketRegionError') {
      return { state: 'error', latencyMs, detail: msg, raw };
    }
    return { state: 'error', latencyMs, detail: msg, raw };
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('aborted') || msg.includes('timeout')) {
    return errorState(latencyMs, 'Request timed out');
  }
  return { ...errorState(latencyMs, msg), raw: msg };
}

function formatS3Meta(e: S3ServiceException): string {
  const meta = e.$metadata as Record<string, unknown> | undefined;
  if (!meta) return '';
  const lines: string[] = [];
  for (const k of ['httpStatusCode', 'requestId', 'extendedRequestId', 'attempts', 'totalRetryDelay']) {
    if (meta[k] != null) lines.push(`${k}: ${meta[k]}`);
  }
  return lines.join('\n');
}

// ─── Cloudflare R2 ──────────────────────────────────────────────────────────
// HeadBucket via S3-compatible endpoint.
export const cloudflareR2: Adapter = {
  id: 'cloudflare-r2',
  label: 'Cloudflare R2',
  kind: 'storage',
  defaultSection: '--cloudflare-r2',
  fields: [
    { key: 'accessKeyId', label: 'Access Key ID', type: 'text', required: true },
    { key: 'secretAccessKey', label: 'Secret Access Key', type: 'password', required: true },
    { key: 'endpoint', label: 'Endpoint (S3)', type: 'url', required: true, placeholder: 'https://<acct>.r2.cloudflarestorage.com' },
    { key: 'bucket', label: 'Bucket', type: 'text', required: true },
    { key: 'region', label: 'Region', type: 'text', placeholder: 'auto' },
  ],
  test: async (creds) => {
    const accessKeyId = (creds.accessKeyId || '').trim();
    const secretAccessKey = (creds.secretAccessKey || '').trim();
    const endpoint = (creds.endpoint || '').trim();
    const bucket = (creds.bucket || '').trim();
    if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
      return errorState(0, 'Missing accessKeyId / secretAccessKey / endpoint / bucket');
    }
    const client = new S3Client({
      endpoint,
      region: (creds.region || 'auto').trim(),
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
    const start = Date.now();
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }), {
        requestTimeout: 6000,
      } as never);
      return valid(Date.now() - start, undefined, `Bucket "${bucket}" accessible`);
    } catch (e) {
      return classifyS3Error(e, Date.now() - start);
    } finally {
      client.destroy();
    }
  },
};

// ─── DigitalOcean Spaces ────────────────────────────────────────────────────
export const doSpaces: Adapter = {
  id: 'do-spaces',
  label: 'DigitalOcean Spaces',
  kind: 'storage',
  defaultSection: '--digitalocean-spaces',
  fields: [
    { key: 'accessKeyId', label: 'Spaces Key', type: 'text', required: true },
    { key: 'secretAccessKey', label: 'Spaces Secret', type: 'password', required: true },
    { key: 'endpoint', label: 'Endpoint', type: 'url', required: true, placeholder: 'https://sgp1.digitaloceanspaces.com' },
    { key: 'bucket', label: 'Bucket / Space', type: 'text', required: true },
    { key: 'region', label: 'Region', type: 'text', placeholder: 'sgp1' },
  ],
  test: async (creds) => {
    const accessKeyId = (creds.accessKeyId || '').trim();
    const secretAccessKey = (creds.secretAccessKey || '').trim();
    const endpoint = (creds.endpoint || '').trim();
    const bucket = (creds.bucket || '').trim();
    const region = (creds.region || '').trim() || endpoint.match(/https?:\/\/([^.]+)\./)?.[1] || 'us-east-1';
    if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
      return errorState(0, 'Missing accessKeyId / secretAccessKey / endpoint / bucket');
    }
    const client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
    const start = Date.now();
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }), {
        requestTimeout: 6000,
      } as never);
      return valid(Date.now() - start, undefined, `Space "${bucket}" accessible`);
    } catch (e) {
      return classifyS3Error(e, Date.now() - start);
    } finally {
      client.destroy();
    }
  },
};
