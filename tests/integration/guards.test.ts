import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { db } from '../../packages/db/src/index.ts';
import { config } from '../../packages/config/src/index.ts';
import { Client, poll, budget } from '../helpers.ts';
const client = new Client();
before(async () => {
  await client.login();
});
after(async () => {
  await db.$disconnect();
});
test('未发布知识与哈希损坏的快照不能进入执行', async () => {
  const original = await db.knowledgeRelease.findUniqueOrThrow({ where: { id: 'sample-knowledge-v1' } });
  const bad = await db.knowledgeRelease.create({
    data: {
      id: randomUUID(),
      projectId: 'sample-project',
      name: '受控损坏快照',
      version: 'invalid-' + randomUUID(),
      hash: 'invalid-hash',
      content: original.content as never,
      published: false,
    },
  });
  const input = {
    projectId: 'sample-project',
    environmentId: 'sample-environment',
    knowledgeReleaseId: bad.id,
    goal: '验证知识完整性 C01',
    mode: 'catalog',
    budget,
  };
  await client.call('/tasks', 'POST', input, 400);
  await db.knowledgeRelease.update({ where: { id: bad.id }, data: { published: true } });
  const task = await client.call('/tasks', 'POST', input);
  await client.call(`/tasks/${task.id}/plans`, 'POST', {});
  const stopped = await poll(async () => {
    const t = await client.call(`/tasks/${task.id}`);
    return t.status === 'ERROR' ? t : null;
  });
  assert.match(stopped.error, /知识/);
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 0);
  await db.task.delete({ where: { id: task.id } });
  await db.knowledgeRelease.delete({ where: { id: bad.id } });
});
test(
  '清理异常保留独立结果与遗留对象，拒绝盲目重跑，并可按命名空间对账',
  { skip: !config.visionReady },
  async () => {
    const env = await client.environment('cleanup-failure');
    const run = await client.run('清理故障反例 C01', { environmentId: env.id });
    assert.equal(run.status, 'ERROR');
    assert.equal(run.cleanupStatus, 'FAILED');
    assert.equal(run.summary[0].result, 'PASS');
    assert.equal(await db.sampleRecord.count({ where: { namespace: run.id + '-C01' } }), 1);
    await client.call(
      `/tasks/${run.taskId}/runs`,
      'POST',
      { revision: run.manifest.revision, idempotencyKey: randomUUID(), parentRunId: run.id },
      400,
    );
    await fs.writeFile(
      '.runtime/verification/cleanup-failure.json',
      JSON.stringify(
        {
          runId: run.id,
          status: run.status,
          businessResult: run.summary[0].result,
          cleanupStatus: run.cleanupStatus,
          rerunBlocked: true,
        },
        null,
        2,
      ),
    );
    // Leave this exact failed fixture for the separate operator reconcile command.
    await client.call(`/admin/environments/${env.id}`, 'PATCH', { enabled: false });
  },
);
