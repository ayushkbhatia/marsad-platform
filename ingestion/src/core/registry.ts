import type { Sql } from './db.js';
import type {
  SourceRecord,
  EndpointConfig,
  NormalizeRule,
  VenueCode,
  DataType,
  Transport,
  RobotsStatus,
  AgentAccount,
} from './types.js';

/**
 * Source registry (§1) — loadSource() reads one ingest.sources row (columns
 * EXACT per 0005) into a typed SourceRecord. Also resolves iam.principals ids
 * for the venue DATA agents so handlers can set app.principal_id and pass
 * agentPrincipalId to SnapshotStore.put (§4).
 *
 * Config over code: adapters NEVER hardcode URLs / action ids — every endpoint
 * shape comes from endpoint_config here.
 */

interface SourceRow {
  id: string | number;
  venue: string;
  data_type: string;
  entry_url: string;
  endpoint_config: EndpointConfig;
  normalize_rules: NormalizeRule[] | null;
  transport: string;
  robots_status: string;
  active: boolean;
  last_content_hash: string | null;
}

function toRecord(row: SourceRow): SourceRecord {
  return {
    id: Number(row.id),
    venue: row.venue as VenueCode,
    dataType: row.data_type as DataType,
    entryUrl: row.entry_url,
    endpointConfig: row.endpoint_config,
    normalizeRules: row.normalize_rules ?? [],
    transport: row.transport as Transport,
    robotsStatus: row.robots_status as RobotsStatus,
    active: row.active,
    lastContentHash: row.last_content_hash,
  };
}

const SELECT_COLS = `id, venue, data_type, entry_url, endpoint_config, normalize_rules,
    transport, robots_status, active, last_content_hash`;

export async function loadSource(sql: Sql, sourceId: number): Promise<SourceRecord> {
  const rows = await sql<SourceRow[]>`
    select id, venue, data_type, entry_url, endpoint_config, normalize_rules,
           transport, robots_status, active, last_content_hash
      from ingest.sources
     where id = ${sourceId}
  `;
  if (rows.length === 0) throw new Error(`ingest.sources row ${sourceId} not found`);
  return toRecord(rows[0]!);
}

export async function loadSourcesForVenue(
  sql: Sql,
  venue: VenueCode,
  opts?: { activeOnly?: boolean; dataType?: DataType },
): Promise<SourceRecord[]> {
  const activeOnly = opts?.activeOnly ?? true;
  const rows = await sql<SourceRow[]>`
    select id, venue, data_type, entry_url, endpoint_config, normalize_rules,
           transport, robots_status, active, last_content_hash
      from ingest.sources
     where venue = ${venue}
       ${activeOnly ? sql`and active` : sql``}
       ${opts?.dataType ? sql`and data_type = ${opts.dataType}` : sql``}
     order by id
  `;
  return rows.map(toRecord);
}

/** The DATA agent handle that owns a given (venue, dataType) task (§2). */
export function agentAccountFor(venue: VenueCode, dataType: DataType): AgentAccount {
  if (dataType === 'filings_list' || dataType === 'filing_detail') return 'DATA-FILINGS';
  return (`DATA-${venue}`) as AgentAccount;
}

/** Resolve an iam.principals handle → id (uuid). Cached per-process by caller if hot. */
export async function resolvePrincipalId(sql: Sql, handle: string): Promise<string> {
  // 'agent' for the per-venue DATA/WRITER/EDITOR accounts; 'system' for the SYSTEM
  // principal that pipeline stages (cross-check) run as (pipelinePrincipalId → 'SYSTEM',
  // seeded kind='system'). Both are non-human service principals.
  const rows = await sql<{ id: string }[]>`
    select id from iam.principals where handle = ${handle} and kind in ('agent', 'system')
  `;
  if (rows.length === 0) throw new Error(`iam.principals service handle '${handle}' not found`);
  return rows[0]!.id;
}

/**
 * Kill switch (§9): a handler must check the owning agent account's run_enabled
 * before acting. Returns false when the agent is disabled.
 */
export async function isAgentRunEnabled(sql: Sql, principalId: string): Promise<boolean> {
  const rows = await sql<{ run_enabled: boolean }[]>`
    select run_enabled from iam.agent_accounts where principal_id = ${principalId}
  `;
  return rows.length > 0 ? rows[0]!.run_enabled : false;
}

// Exported for tests that assert the column list stays in sync with 0005.
export const SOURCE_SELECT_COLS = SELECT_COLS;
