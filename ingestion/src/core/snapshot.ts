import { gzipSync } from 'node:zlib';
import type postgres from 'postgres';
import type { Sql } from './db.js';
import type { IngestionConfig } from './config.js';
import type { StorageUploader } from './storage.js';
import { contentHash } from './normalize.js';
import type {
  SnapshotStore,
  ParseRunRecorder,
  PutSnapshotInput,
  PutSnapshotResult,
  StoredSnapshot,
  Logger,
  VenueCode,
  DataType,
} from './types.js';

/**
 * SnapshotStore + ParseRunRecorder (§4) — the snapshot-first writer.
 *
 * Writes the live ingest.raw_snapshots index (0005) AND lake.snapshots (0004,
 * the content-addressed lineage anchor). Contract steps (§4):
 *
 *  1. Apply source.normalizeRules (+ key-sort JSON) → normalized bytes → sha256.
 *  2. Single-URL sources: sha256 === source.lastContentHash ⇒ deduped=true,
 *     write ONLY an ingest.fetch_log row (changed=false), do NOT store/parse.
 *  3. Changed & gzipped size > INLINE_MAX (32768) ⇒ upload gzip to 'lake-raw'
 *     at {venue}/{data_type}/{yyyy}/{mm}/{dd}/{sha256}.{ext}.gz; else keep
 *     inline in lake.snapshots.body_inline. Always insert ingest.raw_snapshots
 *     (storage_path NOT NULL) and lake.snapshots (sha256 unique, ON CONFLICT DO
 *     NOTHING = free dedupe).
 *  4. ingest.raw_snapshots insert ON CONFLICT (source_id, content_hash,
 *     external_id) NULLS NOT DISTINCT DO NOTHING — an A→B→A flip conflicts
 *     silently (heartbeat, no double-emit).
 *  5. Update ingest.sources: last_content_hash, last_changed_at, last_success_at,
 *     consecutive_failures=0. Always write ingest.fetch_log.
 *
 * fetch_log always carries duration_ms — the caller passes fetchStartedAt.
 */

export interface SnapshotStoreDeps {
  sql: Sql;
  config: IngestionConfig;
  /** Required only when a body exceeds INLINE_MAX (large-blob path). */
  uploader?: StorageUploader;
  logger?: Logger;
}

export interface PutSnapshotInputExt extends PutSnapshotInput {
  /** epoch ms when the fetch began — for ingest.fetch_log.duration_ms. */
  fetchStartedAt?: number;
}

const EXT_BY_KIND: Record<string, string> = {
  json: 'json',
  txt_json: 'json',
  html: 'html',
  xlsx: 'xlsx',
  pdf: 'pdf',
};

export function createSnapshotStore(deps: SnapshotStoreDeps): SnapshotStore {
  const { sql, config, uploader, logger } = deps;

  async function put(input: PutSnapshotInputExt): Promise<PutSnapshotResult> {
    const { source, fetched, agentPrincipalId } = input;
    const startedAt = input.fetchStartedAt ?? Date.now();

    // Step 1: normalize + hash (verbatim bytes remain what we store).
    const { sha256 } = contentHash(fetched.body, source.normalizeRules, fetched.contentType);

    // Step 2: single-URL dedup fast path. A source is "single-URL" when it has
    // no external_id per fetch (quote boards, bulletins) — those carry
    // last_content_hash on ingest.sources. External-id sources dedupe at the
    // raw_snapshots unique index instead (step 4), never here.
    const isSingleUrl = fetched.externalId === undefined || fetched.externalId === null;
    if (isSingleUrl && source.lastContentHash !== null && source.lastContentHash === sha256) {
      await writeFetchLog(sql, source.id, fetched.httpStatus, false, startedAt, null);
      // Bump last_success_at so freshness sweep sees us alive even when unchanged.
      await sql`
        update ingest.sources
           set last_success_at = now(), consecutive_failures = 0
         where id = ${source.id}
      `;
      logger?.info('snapshot deduped (unchanged single-url)', {
        sourceId: source.id,
        sha256,
      });
      return {
        snapshotId: -1,
        lakeSnapshotId: -1,
        sha256,
        deduped: true,
        storagePath: null,
        bytesStored: 0,
      };
    }

    // Step 3: decide inline vs Storage using GZIPPED size.
    const gz = gzipSync(fetched.body);
    const useStorage = gz.byteLength > config.inlineMaxBytes;
    const ext = EXT_BY_KIND[extKindFor(source.dataType, fetched.contentType)] ?? 'bin';
    const storagePath = useStorage
      ? storageKey(source.venue, source.dataType, fetched.fetchedAt, sha256, ext)
      : null;

    // byte_size / bytes_stored consistently record the COMPRESSED (gzip) size —
    // the bytes actually persisted, inline in lake.snapshots.body_inline or as
    // the lake-raw object. Uniform units make the column reliable for
    // storage-accounting / cost queries across both paths.
    let storedBytes = gz.byteLength;
    if (useStorage) {
      if (!uploader) {
        throw new Error(
          `snapshot for source ${source.id} exceeds inline max (${gz.byteLength}B gz) but no Storage uploader configured`,
        );
      }
      const up = await uploader.upload(storagePath!, gz, 'application/gzip');
      storedBytes = up.bytesStored;
    }

    // lake.snapshots: content-addressed lineage anchor (ON CONFLICT sha256 DO NOTHING).
    // body_inline holds gzip bytes iff not using Storage (matches 0004 comment).
    const lakeSourceKey = `${source.venue}:${source.dataType}:${source.id}`;
    const inlineBytes = useStorage ? null : gz;
    const lakeRows = await sql<{ id: number }[]>`
      insert into lake.snapshots
        (sha256, source_key, source_url, venue_code, fetched_at, fetched_by,
         http_status, content_type, byte_size, storage_path, body_inline)
      values
        (${sha256}, ${lakeSourceKey}, ${fetched.url}, ${source.venue},
         ${fetched.fetchedAt}, ${agentPrincipalId}, ${fetched.httpStatus},
         ${fetched.contentType}, ${storedBytes}, ${storagePath}, ${inlineBytes})
      on conflict (sha256) do nothing
      returning id
    `;
    let lakeSnapshotId: number;
    if (lakeRows.length > 0) {
      lakeSnapshotId = lakeRows[0]!.id;
    } else {
      const existing = await sql<{ id: number }[]>`
        select id from lake.snapshots where sha256 = ${sha256}
      `;
      lakeSnapshotId = existing[0]!.id;
    }

    // ingest.raw_snapshots: dedup index (source_id, content_hash, external_id)
    // NULLS NOT DISTINCT. storage_path is NOT NULL there — for inline bodies use
    // the lake.snapshots pointer key so the column is never null.
    const rawStoragePath = storagePath ?? `lake-inline:${lakeSnapshotId}`;
    const externalId = fetched.externalId ?? null;
    const rawRows = await sql<{ id: number }[]>`
      insert into ingest.raw_snapshots
        (source_id, fetched_at, url, http_status, content_type, content_hash,
         storage_path, bytes_stored, external_id, meta)
      values
        (${source.id}, ${fetched.fetchedAt}, ${fetched.url}, ${fetched.httpStatus},
         ${fetched.contentType}, ${sha256}, ${rawStoragePath}, ${storedBytes},
         ${externalId}, ${sql.json((fetched.meta ?? {}) as postgres.JSONValue)})
      on conflict (source_id, content_hash, external_id) do nothing
      returning id
    `;

    if (rawRows.length === 0) {
      // Step 4: silent conflict (A→B→A flip or retry) — heartbeat only.
      await writeFetchLog(sql, source.id, fetched.httpStatus, false, startedAt, null);
      await sql`
        update ingest.sources
           set last_success_at = now(), consecutive_failures = 0
         where id = ${source.id}
      `;
      const existing = await sql<{ id: number }[]>`
        select id from ingest.raw_snapshots
         where source_id = ${source.id} and content_hash = ${sha256}
           and external_id is not distinct from ${externalId}
         order by id desc limit 1
      `;
      logger?.info('snapshot deduped (raw_snapshots conflict)', { sourceId: source.id, sha256 });
      return {
        snapshotId: existing[0]?.id != null ? Number(existing[0].id) : -1,
        lakeSnapshotId,
        sha256,
        deduped: true,
        storagePath,
        bytesStored: storedBytes,
      };
    }

    // postgres.js returns bigint (raw_snapshots.id) as a STRING at runtime despite
    // the `{ id: number }` type — coerce so downstream Number.isFinite checks
    // (LakeStagingEmitter.assertRow) and numeric FKs get a real number.
    const snapshotId = Number(rawRows[0]!.id);

    // Step 5: changed — advance source watermarks + fetch_log(changed=true).
    await sql`
      update ingest.sources
         set last_content_hash = ${sha256},
             last_changed_at   = now(),
             last_success_at   = now(),
             consecutive_failures = 0
       where id = ${source.id}
    `;
    await writeFetchLog(sql, source.id, fetched.httpStatus, true, startedAt, null);

    logger?.info('snapshot stored', {
      sourceId: source.id,
      snapshotId,
      lakeSnapshotId,
      sha256,
      storagePath,
      bytesStored: storedBytes,
    });

    return {
      snapshotId,
      lakeSnapshotId,
      sha256,
      deduped: false,
      storagePath,
      bytesStored: storedBytes,
    };
  }

  async function load(snapshotId: number): Promise<StoredSnapshot> {
    const rows = await sql<
      {
        id: number;
        source_id: number;
        content_type: string;
        content_hash: string;
        external_id: string | null;
        storage_path: string;
        fetched_at: Date | string;
        meta: Record<string, unknown>;
        venue: VenueCode;
        data_type: DataType;
      }[]
    >`
      select rs.id, rs.source_id, rs.content_type, rs.content_hash, rs.external_id,
             rs.storage_path, rs.fetched_at, rs.meta,
             s.venue, s.data_type
        from ingest.raw_snapshots rs
        join ingest.sources s on s.id = rs.source_id
       where rs.id = ${snapshotId}
    `;
    if (rows.length === 0) {
      throw new Error(`snapshot ${snapshotId} not found`);
    }
    const r = rows[0]!;

    // Body lives in lake.snapshots (inline gzip) or Storage. We resolve via the
    // content hash → lake.snapshots row.
    const lake = await sql<{ body_inline: Buffer | null; storage_path: string | null }[]>`
      select body_inline, storage_path from lake.snapshots where sha256 = ${r.content_hash}
    `;
    let body: Buffer;
    if (lake.length > 0 && lake[0]!.body_inline) {
      const { gunzipSync } = await import('node:zlib');
      body = gunzipSync(lake[0]!.body_inline!);
    } else if (lake[0]?.storage_path) {
      // Storage-backed body (large blob): download the gzip from lake-raw and
      // gunzip. Enables replay / golden re-parse of the highest-value feeds
      // (TDWL main-market JSON, EOD XLSX) — CONTRACT §10.
      if (!uploader) {
        throw new Error(
          `snapshot ${snapshotId} body is in Storage (${lake[0]!.storage_path}) but no Storage uploader configured to download it`,
        );
      }
      const { gunzipSync } = await import('node:zlib');
      const gz = await uploader.download(lake[0]!.storage_path!);
      body = gunzipSync(gz);
    } else {
      throw new Error(`snapshot ${snapshotId} body not available (purged or externally stored)`);
    }

    return {
      snapshotId: r.id,
      sourceId: r.source_id,
      venue: r.venue,
      dataType: r.data_type,
      contentType: r.content_type,
      externalId: r.external_id,
      body,
      fetchedAt: typeof r.fetched_at === 'string' ? r.fetched_at : r.fetched_at.toISOString(),
      meta: r.meta ?? {},
    };
  }

  return { put: put as SnapshotStore['put'], load };
}

async function writeFetchLog(
  sql: Sql,
  sourceId: number,
  httpStatus: number,
  changed: boolean,
  startedAt: number,
  error: string | null,
): Promise<void> {
  const durationMs = Math.max(0, Date.now() - startedAt);
  await sql`
    insert into ingest.fetch_log (source_id, http_status, changed, duration_ms, error)
    values (${sourceId}, ${httpStatus}, ${changed}, ${durationMs}, ${error})
  `;
}

export function createParseRunRecorder(sql: Sql): ParseRunRecorder {
  return {
    async record(input): Promise<number> {
      const rows = await sql<{ id: number }[]>`
        insert into ingest.parse_runs
          (snapshot_id, parser_version, status, rows_emitted, error)
        values
          (${input.snapshotId}, ${input.parserVersion}, ${input.status},
           ${input.rowsEmitted}, ${input.error ?? null})
        returning id
      `;
      return rows[0]!.id;
    },
  };
}

/** {venue}/{data_type}/{yyyy}/{mm}/{dd}/{sha256}.{ext}.gz — content-addressed. */
export function storageKey(
  venue: VenueCode,
  dataType: DataType,
  fetchedAtIso: string,
  sha256: string,
  ext: string,
): string {
  const d = new Date(fetchedAtIso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${venue}/${dataType}/${yyyy}/${mm}/${dd}/${sha256}.${ext}.gz`;
}

function extKindFor(dataType: DataType, contentType: string): string {
  if (dataType === 'eod_bulletin' || dataType === 'ohlcv_backfill') return 'xlsx';
  if (/pdf/i.test(contentType)) return 'pdf';
  if (/json/i.test(contentType)) return 'json';
  if (/html/i.test(contentType)) return 'html';
  // TDWL sends text/html for JSON — the data_type disambiguates.
  if (dataType === 'quotes' || dataType === 'indices' || dataType === 'filings_list') return 'json';
  return 'html';
}
