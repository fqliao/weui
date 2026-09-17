import { z } from 'zod';
import type { AssertionResult } from '../../contracts/src/index.ts';
export const observationSchema = z.object({
  records: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      amount: z.number(),
      applicant: z.string(),
      reviewer: z.string().nullable(),
      submitCount: z.number(),
      tenant: z.string(),
      namespace: z.string(),
      title: z.string(),
    }),
  ),
  audit: z.array(
    z.object({ recordId: z.string(), action: z.string(), actor: z.string(), namespace: z.string() }),
  ),
});
export type Observation = z.infer<typeof observationSchema>;
export function verifyCase(
  id: string,
  observation: Observation,
  ui: { message: string; visibleRecords: number },
): AssertionResult[] {
  const a: AssertionResult[] = [];
  const rec = observation.records[0];
  const add = (name: string, ruleId: string, expected: unknown, actual: unknown) =>
    a.push({
      id: name,
      ruleId,
      expected,
      actual: actual ?? null,
      passed: JSON.stringify(expected) === JSON.stringify(actual),
    });
  if (['C04', 'C05', 'C06', 'C07', 'C08'].includes(id)) {
    add('record.count', ['C04', 'C05'].includes(id) ? 'R01' : 'R02', 0, observation.records.length);
    add(
      'ui.validation',
      ['C04', 'C05'].includes(id) ? 'R01' : 'R02',
      true,
      /标题长度|金额必须/.test(ui.message),
    );
    return a;
  }
  add('record.count', 'R10', 1, observation.records.length);
  if (id === 'C01') {
    add('record.status', 'R03', 'DRAFT', rec?.status);
    add('record.amount', 'R02', 100, rec?.amount);
  }
  if (id === 'C02' || id === 'C03') {
    add('record.status', id === 'C02' ? 'R04' : 'R05', id === 'C02' ? 'APPROVED' : 'REJECTED', rec?.status);
    add('record.reviewer', 'R04', 'reviewer', rec?.reviewer);
    add(
      'audit.review',
      'R04',
      1,
      observation.audit.filter(
        (x) =>
          x.action === (id === 'C02' ? 'approve' : 'reject') &&
          x.actor === 'reviewer' &&
          x.recordId === rec?.id,
      ).length,
    );
  }
  if (['C09', 'C10', 'C12'].includes(id)) {
    add('record.status', id === 'C10' ? 'R07' : 'R06', 'PENDING', rec?.status);
    add(
      'audit.noApprove',
      'R06',
      0,
      observation.audit.filter((x) => x.action === 'approve' || x.action === 'reject').length,
    );
    add('ui.denied', id === 'C12' ? 'R09' : 'R06', true, /无权|无审批权限|不能审批自己的/.test(ui.message));
    if (id === 'C12') add('ui.noForeignRecord', 'R09', 0, ui.visibleRecords);
  }
  if (id === 'C11') {
    add('record.status', 'R03', 'PENDING', rec?.status);
    add('record.submitCount', 'R08', 1, rec?.submitCount);
    add(
      'audit.submitCount',
      'R08',
      1,
      observation.audit.filter((x) => x.action === 'submit' && x.recordId === rec?.id).length,
    );
  }
  return a;
}
