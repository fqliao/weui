import fs from 'node:fs/promises';
import { db, json } from '../packages/db/src/index.ts';
import { config, hash } from '../packages/config/src/index.ts';
import { passwordHash } from '../packages/auth/src/index.ts';
import { CASES, RULES, ontology } from '../packages/knowledge/src/catalog.ts';
import type { SkillDraft } from '../packages/contracts/src/index.ts';
await fs.mkdir('knowledge/wiki', { recursive: true });
await fs.mkdir('knowledge/releases', { recursive: true });
await fs.mkdir('knowledge/rules', { recursive: true });
await fs.mkdir('knowledge/ontology', { recursive: true });
const pages = [
  {
    id: 'overview',
    title: '审批领域总览',
    body: '该知识包只适用于随 MVP 提供的独立审批样例系统。涉及申请、角色、租户、状态、规则、审计。真实系统接入时必须由业务负责人审核并发布自己的规则。',
  },
  {
    id: 'flow',
    title: '申请与审批流程',
    body: '申请人创建草稿，提交后进入 PENDING；另一位 reviewer 可以通过或驳回。所有结论需查询持久化状态；提示文字只是辅助证据。',
  },
  {
    id: 'roles',
    title: '角色与权限',
    body: 'applicant 可创建和提交申请；reviewer 可审批他人申请。双方都受租户限制。自审批禁止。参考 R04、R06、R07、R09。',
  },
  {
    id: 'boundaries',
    title: '表单与金额边界',
    body: '标题长度 1-200 字符，金额为 1-1000000 整数。空值、过长、零、负数、超限都应被拒绝。参考 R01、R02。',
  },
  {
    id: 'idempotency',
    title: '重复提交与未知结果',
    body: '重复提交不重复转换状态或增加审计。写操作结果未知时先查询，不能自动重放。参考 R03、R08。',
  },
  {
    id: 'evidence',
    title: '证据与测试方法',
    body: '用例必须绑定规则、断言、业务对象、首次失败证据。数据以 run_id 隔离并清理。证据不足为 INCONCLUSIVE，依赖缺失为 BLOCKED。参考 R10。',
  },
].map((p) => ({ ...p, source: 'sample-approval-spec@1.0', status: 'SAMPLE_APPROVED' }));
const content = {
  pages,
  rules: RULES,
  ontology,
  cases: CASES,
  source: 'sample-approval-spec@1.0',
  sample: true,
};
for (const p of pages)
  await fs.writeFile(
    `knowledge/wiki/${p.id}.md`,
    `# ${p.title}\n\n来源：${p.source}；状态：样例规则。\n\n${p.body}\n`,
  );
await fs.writeFile('knowledge/rules/sample-approval.json', JSON.stringify(RULES, null, 2));
await fs.writeFile('knowledge/ontology/sample-approval.json', JSON.stringify(ontology, null, 2));
await fs.writeFile(
  'knowledge/releases/sample-v1.json',
  JSON.stringify({ id: 'sample-knowledge-v1', hash: hash(content), content }, null, 2),
);
for (const [role, email, name, password] of [
  ['ADMIN', process.env.BOOTSTRAP_ADMIN_EMAIL, '项目管理员', process.env.BOOTSTRAP_ADMIN_PASSWORD],
  ['TESTER', process.env.BOOTSTRAP_TESTER_EMAIL, '体验测试人员', process.env.BOOTSTRAP_TESTER_PASSWORD],
] as const) {
  if (!email || !password || password.length < 12 || password.startsWith('REPLACE'))
    throw new Error('请在 .env 配置至少 12 位的初始账号密码');
  await db.user.upsert({
    where: { email },
    update: {},
    create: { email, name: name!, role: role!, passwordHash: passwordHash(password) },
  });
}
const project = await db.project.upsert({
  where: { id: 'sample-project' },
  update: {},
  create: {
    id: 'sample-project',
    name: '审批业务体验空间',
    description: '独立样例系统 · 真实浏览器与业务断言 · 不代表企业系统验收',
    sample: true,
  },
});
for (const u of await db.user.findMany({
  where: { email: { in: [process.env.BOOTSTRAP_ADMIN_EMAIL!, process.env.BOOTSTRAP_TESTER_EMAIL!] } },
}))
  await db.membership.upsert({
    where: { userId_projectId: { userId: u.id, projectId: project.id } },
    update: {},
    create: { userId: u.id, projectId: project.id },
  });
await db.environment.upsert({
  where: { id: 'sample-environment' },
  update: { baseUrl: config.SAMPLE_ORIGIN },
  create: {
    id: 'sample-environment',
    projectId: project.id,
    name: '审批样例 · 隔离测试',
    baseUrl: config.SAMPLE_ORIGIN,
    adapter: 'sample-approval-v1',
    credentialRef: 'SAMPLE_SERVICE_KEY',
    config: { sample: true, fault: 'none', delayMs: 0 },
  },
});
await db.knowledgeRelease.upsert({
  where: { id: 'sample-knowledge-v1' },
  update: {},
  create: {
    id: 'sample-knowledge-v1',
    projectId: project.id,
    name: '审批领域知识',
    version: '1.0.0',
    hash: hash(content),
    content: json(content),
  },
});
const owner = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
for (const template of [
  {
    id: 'template-permission',
    name: '审批权限检查',
    description: '验证角色、自审批与租户隔离',
    caseIds: ['C09', 'C10', 'C12'],
    ruleIds: ['R04', 'R06', 'R07', 'R09', 'R10'],
  },
  {
    id: 'template-boundary',
    name: '表单边界检查',
    description: '验证必填、长度、金额和重复提交',
    caseIds: ['C04', 'C05', 'C06', 'C07', 'C08', 'C11'],
    ruleIds: ['R01', 'R02', 'R03', 'R08', 'R10'],
  },
]) {
  const draft: SkillDraft = {
    name: template.name,
    description: template.description,
    caseIds: template.caseIds,
    ruleIds: template.ruleIds,
    toolIds: [
      'knowledge.search',
      'browser.run_case',
      'business.query',
      'fixture.prepare',
      'fixture.cleanup',
      'assertions.verify',
    ],
    instructions:
      '先读取任务锁定的规则与来源，选择相关用例。使用已注册工具准备隔离数据，通过 UI 执行操作，再独立查询状态和审计。缺规则即阻断，证据不足标为不确定。不要修改预期，不要执行未注册代码。',
    inputSchema: { goal: 'string' },
    outputSchema: { cases: 'CaseResult[]' },
  };
  await db.skill.upsert({
    where: { id: template.id },
    update: {},
    create: {
      id: template.id,
      projectId: project.id,
      ownerId: owner.id,
      name: template.name,
      description: template.description,
      template: true,
      draft: json(draft),
      draftHash: hash(draft),
    },
  });
  await fs.mkdir(`skills/${template.id}`, { recursive: true });
  await fs.writeFile(
    `skills/${template.id}/SKILL.md`,
    `---\nname: ${template.id}\ndescription: ${template.description}\n---\n\n${draft.instructions}\n`,
  );
}
await db.setting.upsert({
  where: { key: 'execution_enabled' },
  update: {},
  create: { key: 'execution_enabled', value: true },
});
console.log('样例项目、知识快照、两份 Skill 模板和受邀账号已就绪。模板必须调试后发布。');
await db.$disconnect();
