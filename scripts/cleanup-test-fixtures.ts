import { db } from '../packages/db/src/index.ts';
// Only artificial authorization fixtures created by tests/integration/platform.test.ts.
const projects = await db.project.findMany({
  where: { name: '权限隔离验证', description: '自动化创建的权限反例项目', sample: false },
});
for (const project of projects) {
  const tasks = await db.task.findMany({ where: { projectId: project.id } });
  for (const task of tasks) {
    const runs = await db.run.findMany({ where: { taskId: task.id } });
    for (const run of runs) {
      await db.evidence.deleteMany({
        where: { runId: run.id, kind: 'screenshot', fileName: 'restricted.png', path: 'restricted.png' },
      });
      await db.run.delete({ where: { id: run.id } });
    }
    await db.task.delete({ where: { id: task.id } });
  }
  await db.project.delete({ where: { id: project.id } });
}
console.log(`Removed ${projects.length} synthetic authorization fixtures`);
await db.$disconnect();
