import type { Logger } from './types.js';

/**
 * Supabase Storage uploader for the private 'lake-raw' bucket (§4 step 3).
 *
 * Uses the service-role key — the documented least-privilege exception, ONLY
 * for bucket writes (01 §3.1). Never for PostgREST data access. The bucket is
 * pre-created (ops.ensure_bucket('lake-raw', false)); we only upload objects.
 *
 * Injectable transport for tests so no live Storage round-trip is needed.
 */

export interface StorageUploadResult {
  path: string;
  bytesStored: number;
}

export interface StorageUploader {
  upload(path: string, body: Buffer, contentType: string): Promise<StorageUploadResult>;
  /**
   * Download an object's raw bytes from the bucket (GET
   * /storage/v1/object/{bucket}/{key} with the service-role key). Used by
   * SnapshotStore.load() to resolve Storage-backed snapshot bodies for replay /
   * golden re-parse (CONTRACT §10). Returns the verbatim stored bytes (for
   * lake-raw that is the gzip; the caller gunzips).
   */
  download(path: string): Promise<Buffer>;
}

export interface StorageUploaderOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  bucket: string;
  logger?: Logger;
  transport?: StorageTransport;
}

export interface StorageTransport {
  (
    url: string,
    opts: { method: string; headers: Record<string, string>; body?: Buffer },
  ): Promise<{ statusCode: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;
}

export function createStorageUploader(opts: StorageUploaderOptions): StorageUploader {
  const base = opts.supabaseUrl.replace(/\/+$/, '');
  const transport: StorageTransport = opts.transport ?? defaultStorageTransport;

  return {
    async upload(path, body, contentType): Promise<StorageUploadResult> {
      const key = path.replace(/^\/+/, '');
      const url = `${base}/storage/v1/object/${opts.bucket}/${key}`;
      const res = await transport(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.serviceRoleKey}`,
          apikey: opts.serviceRoleKey,
          'content-type': contentType,
          // Upsert so a re-run of the same content-addressed key is idempotent.
          'x-upsert': 'true',
          'cache-control': 'max-age=31536000',
        },
        body,
      });
      if (res.statusCode >= 300) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `lake-raw upload failed (${res.statusCode}) for ${key}: ${detail.slice(0, 500)}`,
        );
      }
      opts.logger?.info('lake-raw upload ok', { key, bytes: body.length });
      return { path: key, bytesStored: body.length };
    },

    async download(path): Promise<Buffer> {
      const key = path.replace(/^\/+/, '');
      const url = `${base}/storage/v1/object/${opts.bucket}/${key}`;
      const res = await transport(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${opts.serviceRoleKey}`,
          apikey: opts.serviceRoleKey,
        },
      });
      if (res.statusCode >= 300) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `lake-raw download failed (${res.statusCode}) for ${key}: ${detail.slice(0, 500)}`,
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      opts.logger?.info('lake-raw download ok', { key, bytes: buf.length });
      return buf;
    },
  };
}

const defaultStorageTransport: StorageTransport = async (url, opts) => {
  const { request: undiciRequest } = await import('undici');
  const res = await undiciRequest(url, {
    method: opts.method as never,
    headers: opts.headers,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
  return {
    statusCode: res.statusCode,
    text: () => res.body.text(),
    arrayBuffer: () => res.body.arrayBuffer(),
  };
};
