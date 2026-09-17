import { db } from '../packages/db/src/index.ts';
const tasks = await db.task.findMany({
  where: { title: { contains: 'Web 自定义幂等检查' } },
  include: { plans: true },
  orderBy: { createdAt: 'desc' },
  take: 3,
});
console.log(
  JSON.stringify(
    tasks.map((t) => ({
      title: t.title,
      status: t.status,
      error: t.error,
      plans: t.plans.map((p) => ({
        requirements: (p.content as any).missingRequirements,
        cases: (p.content as any).cases.map((c: any) => c.id),
      })),
    })),
    null,
    2,
  ),
);
await db.$disconnect();
