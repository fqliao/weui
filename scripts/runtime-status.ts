import { db } from '../packages/db/src/index.ts';
console.log(
  JSON.stringify(
    {
      tasks: await db.task.findMany({
        where: { status: 'PLANNING' },
        select: { id: true, title: true, status: true },
      }),
      runs: await db.run.findMany({
        where: { projectId: 'sample-project', status: { in: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] } },
        select: { id: true, status: true, task: { select: { title: true } } },
      }),
    },
    null,
    2,
  ),
);
await db.$disconnect();
