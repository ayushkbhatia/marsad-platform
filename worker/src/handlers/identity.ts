import type { Sql } from '../db.js';
import type { AgentAccount } from './ingestion-runtime.js';

/**
 * Per-job agent identity + kill-switch enforcement (CONTRACT §9; 01 §3.2).
 *
 * Every ingestion job runs AS a DATA agent. Before doing any work the handler
 * must:
 *   1. Resolve the agent's iam.principals.id from its handle.
 *   2. Check the per-agent kill switch (iam.agent_accounts.run_enabled) AND the
 *      global switch (iam.global_switches 'pause_all_agents'). Either off ⇒ the
 *      job is a no-op (skipped, not failed).
 *   3. Set the transaction-local GUCs app.principal_id / app.principal_kind so
 *      the lake's RLS + agent-gate triggers attribute writes to this agent
 *      (fn_enforce_agent_publish_gate, fn_datapoint_fanout, etc. all read them).
 *
 * The GUCs are set with is_local = true so they scope to the current
 * transaction only. Callers MUST therefore run the guarded work inside a single
 * `sql.begin()` transaction — `runAsAgent` enforces that by taking the tx sql.
 *
 * IDENTITY SEAM — where the GUC actually applies (read this before trusting it):
 *   is_local GUCs are scoped to the connection+transaction that set them. The
 *   handler-side GUC set by `setPrincipalGucs(tx, …)` therefore covers ONLY the
 *   queries the handler itself issues on `tx` inside `runAsAgent` — e.g. the
 *   seen_items diff and the filing_detail wake-up enqueue in filings_poll.
 *
 *   It does NOT cover the real lake-writing work. runtime.runTask() and
 *   crossCheck.resolve() run through the ingestion runtime's OWN pooled
 *   connection(s), not this tx, so they never see the handler's app.principal_id.
 *   That is by design: the handler passes the resolved principal id
 *   (identity.principalId → runTask's `agentPrincipalId`; pipelinePrincipalId →
 *   the cross-check agent) as a VALUE, and the runtime is contractually required
 *   to set app.principal_id / app.principal_kind itself on its own write
 *   transaction from that value before it touches lake.* (CONTRACT §2 identity
 *   note, §4 PutSnapshotInput.agentPrincipalId, §7 verified_by). The handler MUST
 *   NOT assume its set_config reaches the runtime's writes.
 */

export class AgentPausedError extends Error {
  readonly agentAccount: AgentAccount;
  constructor(agentAccount: AgentAccount, reason: 'run_disabled' | 'globally_paused') {
    super(`agent ${agentAccount} is paused (${reason})`);
    this.name = 'AgentPausedError';
    this.agentAccount = agentAccount;
  }
}

export class UnknownAgentError extends Error {
  constructor(agentAccount: AgentAccount) {
    super(`no iam.principals row for agent handle ${agentAccount}`);
    this.name = 'UnknownAgentError';
  }
}

export interface AgentIdentity {
  agentAccount: AgentAccount;
  principalId: string;
}

/**
 * Resolve a DATA agent handle → principal id and confirm it is allowed to run
 * right now. Throws AgentPausedError if the kill switch is engaged (the caller
 * treats that as a clean skip, not a retryable failure).
 */
export async function resolveActiveAgent(
  sql: Sql,
  agentAccount: AgentAccount,
): Promise<AgentIdentity> {
  const rows = (await sql`
    select p.id::text                     as principal_id,
           a.run_enabled                  as run_enabled,
           coalesce(
             (select gs.value from iam.global_switches gs where gs.key = 'pause_all_agents'),
             false
           )                              as globally_paused
    from iam.principals p
    join iam.agent_accounts a on a.principal_id = p.id
    where p.handle = ${agentAccount}
  `) as unknown as Array<{
    principal_id: string;
    run_enabled: boolean;
    globally_paused: boolean;
  }>;

  const row = rows[0];
  if (!row) throw new UnknownAgentError(agentAccount);
  if (row.globally_paused) throw new AgentPausedError(agentAccount, 'globally_paused');
  if (!row.run_enabled) throw new AgentPausedError(agentAccount, 'run_disabled');

  return { agentAccount, principalId: row.principal_id };
}

/**
 * Set the transaction-local principal GUCs. MUST be called inside the same
 * transaction as the guarded work so the lake triggers see the right agent.
 */
export async function setPrincipalGucs(tx: Sql, principalId: string): Promise<void> {
  // set_config(key, value, is_local=true): scoped to the current transaction.
  const agentKind = 'agent';
  await tx`select set_config('app.principal_id', ${principalId}, true)`;
  await tx`select set_config('app.principal_kind', ${agentKind}, true)`;
}

/**
 * Run `work` as the given agent inside one transaction with identity GUCs set.
 * Resolves + kill-switch-checks the agent first (outside the tx, cheap read),
 * then opens the tx, stamps the GUCs, and runs the body. Throwing rolls back.
 *
 * The tx GUCs cover ONLY the queries `work` runs on the provided `tx`
 * (e.g. seen_items / job_queue enqueues). Work handed to the ingestion runtime
 * (runTask, crossCheck) runs on the runtime's own connection and does NOT see
 * these GUCs — pass `identity.principalId` to the runtime, which sets its own
 * identity from that value (see the module header "IDENTITY SEAM").
 */
export async function runAsAgent<T>(
  sql: Sql,
  agentAccount: AgentAccount,
  work: (tx: Sql, identity: AgentIdentity) => Promise<T>,
): Promise<T> {
  const identity = await resolveActiveAgent(sql, agentAccount);
  return sql.begin(async (tx) => {
    await setPrincipalGucs(tx as unknown as Sql, identity.principalId);
    return work(tx as unknown as Sql, identity);
  }) as Promise<T>;
}

/**
 * Confirm the global agent kill switch is off (pause_all_agents). Pipeline
 * stages (cross_check, key_ratios) run under a runtime-owned principal id
 * rather than a handle, so they honor only the global switch. Throws
 * AgentPausedError('globally_paused') when engaged.
 */
export async function assertAgentsNotGloballyPaused(sql: Sql): Promise<void> {
  const rows = (await sql`
    select coalesce(
      (select gs.value from iam.global_switches gs where gs.key = 'pause_all_agents'),
      false
    ) as globally_paused
  `) as unknown as Array<{ globally_paused: boolean }>;
  if (rows[0]?.globally_paused) {
    throw new AgentPausedError('DATA-FILINGS', 'globally_paused');
  }
}

/**
 * Run `work` inside one transaction as a known principal id (pipeline stages).
 * Honors the global pause switch; there is no per-agent handle to check here.
 */
export async function runAsPrincipalId<T>(
  sql: Sql,
  principalId: string,
  work: (tx: Sql) => Promise<T>,
): Promise<T> {
  await assertAgentsNotGloballyPaused(sql);
  return sql.begin(async (tx) => {
    await setPrincipalGucs(tx as unknown as Sql, principalId);
    return work(tx as unknown as Sql);
  }) as Promise<T>;
}
