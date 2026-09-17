import { AppError } from '../../config/src/index.ts';
import { assertAllowedUrl } from '../../websites/src/policy.ts';
import { discoveryOutputSchema, requirementLines, type Observation } from '../../contracts/src/discovery.ts';
export function safeNavigation(text: string, href: string, baseUrl: string, origins: string[]) {
  const url = assertAllowedUrl(href, baseUrl, origins);
  if (
    !text.trim() ||
    /退出|注销|删除|移除|提交|批准|驳回|支付|购买|下载|导出|logout|sign.?out|delete|remove|submit|approve|reject|checkout|purchase|download|export/i.test(
      `${text} ${decodeURIComponent(url)}`,
    )
  )
    throw new AppError('EXPLORE_NAVIGATION', '此链接可能改变业务数据，留待人工确认');
  return url;
}
export function validateCandidates(
  raw: unknown,
  observations: Observation[],
  requirements: string,
  sessionId: string | null,
  domainRules: { id: string }[] = [],
) {
  const output = discoveryOutputSchema.parse(raw);
  const refs = new Set(requirementLines(requirements).map((r) => r.id));
  const pages = new Set(observations.map((o) => o.id));
  const urls = new Set(observations.map((o) => o.url));
  for (const candidate of output.candidates) {
    if (
      candidate.requirementRefs.some((r) => !refs.has(r)) ||
      candidate.observationIds.some((id) => !pages.has(id))
    )
      throw new AppError('DISCOVERY_SOURCE', '草稿引用了未提供的需求或未探索页面');
    if (!urls.has(candidate.test.startPath))
      throw new AppError('DISCOVERY_SOURCE', '草稿入口必须来自实际探索的页面');
    if (candidate.knowledgeRuleRefs.some((id) => !domainRules.some((r) => r.id === id)))
      throw new AppError('DISCOVERY_SOURCE', '草稿引用了不存在的领域规则');
    if (
      candidate.basis === 'requirement' &&
      !candidate.requirementRefs.length &&
      !candidate.knowledgeRuleRefs.length
    )
      throw new AppError('DISCOVERY_SOURCE', '基于需求的草稿缺少需求引用');
    // The model can suggest expectations, but cannot choose credentials or publish cases.
    candidate.test.sessionId = sessionId;
    candidate.test.enabled = false;
    candidate.test.verifySessionOnly = false;
  }
  return output;
}
