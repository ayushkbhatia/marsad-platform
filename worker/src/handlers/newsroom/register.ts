/**
 * Register the P3.3 newsroom pipeline handlers on q_pipeline. Unlike the ingestion
 * handlers these need no IngestionRuntime — only the DB + the LLM gateway (imported
 * from marsad-ingestion) — so they self-register at boot with no injected deps.
 *
 *   pipeline_classify  VERIFIED lake object → materiality verdict → piece + draft
 *   pipeline_draft     writer-context pack → chatComplete('writer') → blocks+citations
 *   pipeline_edit      tighten headline + template auto-select
 *   pipeline_rules     runRules R-01..R-10 → approval / auto-publish / rules loop
 */
import { registerHandler } from '../index.js';
import { makeClassify } from './classify.js';
import { makeDraft } from './draft.js';
import { makeEdit } from './edit.js';
import { makeRulesStage } from './rules-stage.js';

export function registerNewsroomHandlers(): string[] {
  const regs: [string, ReturnType<typeof makeClassify>][] = [
    ['pipeline_classify', makeClassify()],
    ['pipeline_draft', makeDraft()],
    ['pipeline_edit', makeEdit()],
    ['pipeline_rules', makeRulesStage()],
  ];
  for (const [name, h] of regs) registerHandler(name, h);
  return regs.map(([n]) => n);
}
