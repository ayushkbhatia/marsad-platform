import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveActiveAgent,
  runAsAgent,
  runAsPrincipalId,
  AgentPausedError,
  UnknownAgentError,
} from '../identity.js';
import { makeFakeSql, activeAgentRows } from './fakes.js';

test('resolveActiveAgent: returns principal id for a runnable agent', async () => {
  const { sql, on } = makeFakeSql();
  on('iam.agent_accounts', activeAgentRows('pid-1'));
  const id = await resolveActiveAgent(sql, 'DATA-QE');
  assert.equal(id.principalId, 'pid-1');
  assert.equal(id.agentAccount, 'DATA-QE');
});

test('resolveActiveAgent: unknown handle throws UnknownAgentError', async () => {
  const { sql } = makeFakeSql(); // no canned row ⇒ empty result
  await assert.rejects(() => resolveActiveAgent(sql, 'DATA-ADX'), UnknownAgentError);
});

test('resolveActiveAgent: run_enabled=false throws AgentPausedError(run_disabled)', async () => {
  const { sql, on } = makeFakeSql();
  on('iam.agent_accounts', [{ principal_id: 'p', run_enabled: false, globally_paused: false }]);
  await assert.rejects(() => resolveActiveAgent(sql, 'DATA-TDWL'), (e: unknown) => {
    assert.ok(e instanceof AgentPausedError);
    assert.match((e as Error).message, /run_disabled/);
    return true;
  });
});

test('resolveActiveAgent: global pause throws AgentPausedError(globally_paused)', async () => {
  const { sql, on } = makeFakeSql();
  on('iam.agent_accounts', [{ principal_id: 'p', run_enabled: true, globally_paused: true }]);
  await assert.rejects(() => resolveActiveAgent(sql, 'DATA-DFM'), (e: unknown) => {
    assert.ok(e instanceof AgentPausedError);
    assert.match((e as Error).message, /globally_paused/);
    return true;
  });
});

test('runAsAgent: sets both identity GUCs inside the transaction', async () => {
  const { sql, on, queries } = makeFakeSql();
  on('iam.agent_accounts', activeAgentRows('pid-xyz'));
  const out = await runAsAgent(sql, 'DATA-MSX', async () => 'body-ran');
  assert.equal(out, 'body-ran');
  const gucs = queries.filter((q) => q.text.includes('set_config'));
  assert.ok(gucs.some((q) => q.values.includes('pid-xyz')));
  assert.ok(gucs.some((q) => q.values.includes('agent')));
});

test('runAsPrincipalId: honors the global pause switch', async () => {
  const { sql, on } = makeFakeSql();
  on('pause_all_agents', [{ globally_paused: true }]);
  await assert.rejects(() => runAsPrincipalId(sql, 'pid-pipe', async () => 1), AgentPausedError);
});

test('runAsPrincipalId: sets the given principal id when not paused', async () => {
  const { sql, on, queries } = makeFakeSql();
  on('pause_all_agents', [{ globally_paused: false }]);
  const out = await runAsPrincipalId(sql, 'pid-pipe', async () => 7);
  assert.equal(out, 7);
  assert.ok(queries.some((q) => q.text.includes('set_config') && q.values.includes('pid-pipe')));
});
