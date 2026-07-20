/**
 * Shared plumbing for the P3.3 newsroom pipeline handlers (03 §4/§7).
 *
 * The conveyor is a chain of pgmq q_pipeline messages, each keyed by a `handler`
 * name (pipeline_classify → pipeline_draft → pipeline_edit → pipeline_rules).
 * ops.pipeline_items.stage tracks WHERE a piece is; ops.fn_transition moves it
 * (DB-enforced adjacency). Every stage is idempotent: a redelivered message whose
 * item has already advanced is a no-op.
 *
 * Kill switches (re-checked every message, 03 §9.3): pause_all_agents halts all
 * drafting; kill_all_output additionally suppresses any content mutation.
 */
import type { Sql } from '../../db.js';
import { pgmqSend } from '../enqueue.js';

export const Q_PIPELINE = 'q_pipeline';

/** Resolve an agent handle → principal id (WRITER-1 / EDITOR-1 / DATA-FILINGS …). */
export async function resolvePrincipal(sql: Sql, handle: string): Promise<string> {
  const rows = (await sql`select id::text as id from iam.principals where handle = ${handle} limit 1`) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error(`newsroom: principal ${handle} not found`);
  return rows[0].id;
}

/** True when the named boolean global switch is on. */
export async function switchOn(sql: Sql, key: string): Promise<boolean> {
  const rows = (await sql`select coalesce((select value from iam.global_switches where key = ${key}), false) as v`) as unknown as Array<{ v: boolean }>;
  return rows[0]?.v === true;
}

/** Both output-halting switches. When either is on, drafting/mutation stages skip cleanly. */
export async function outputHalted(sql: Sql): Promise<boolean> {
  return (await switchOn(sql, 'pause_all_agents')) || (await switchOn(sql, 'kill_all_output'));
}

/** Enqueue the next stage of the conveyor for an item. */
export async function enqueueStage(sql: Sql, handler: string, pipelineItemId: number): Promise<void> {
  await pgmqSend(sql, Q_PIPELINE, { handler, pipeline_item_id: pipelineItemId });
}

/** One pipeline_items row (the fields the handlers read). */
export interface PipelineItem {
  id: number;
  content_id: string;
  stage: string;
  trigger_object_id: string | null;
  priority: string | null;
  template_hint: string | null;
  rules_fail_loops: number;
  security_id: number | null;
}

export async function loadItem(sql: Sql, id: number): Promise<PipelineItem | null> {
  const rows = (await sql`
    select pi.id, pi.content_id::text, pi.stage, pi.trigger_object_id::text,
           pi.priority, pi.template_hint, pi.rules_fail_loops,
           (select ct.security_id from public.content_tickers ct where ct.content_id = pi.content_id and ct.is_primary limit 1) as security_id
      from ops.pipeline_items pi where pi.id = ${id}
  `) as unknown as Array<PipelineItem>;
  return rows[0] ?? null;
}

/** Move a pipeline item to a new stage (validates adjacency in the DB). */
export async function transition(sql: Sql, itemId: number, to: string, actorPrincipalId: string, detail: Record<string, unknown> = {}): Promise<void> {
  await sql`select ops.fn_transition(${itemId}::bigint, ${to}, ${actorPrincipalId}::uuid, ${sql.json(detail as never)}::jsonb)`;
}

/** Strip a markdown code fence + parse the first JSON object out of an LLM reply. */
export function parseJsonReply(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const s = body.indexOf('{'), e = body.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('no json object in reply');
  return JSON.parse(body.slice(s, e + 1));
}

/** Naive word count (matches the content_items.word_count contract). */
export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
