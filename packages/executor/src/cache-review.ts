import { parse, stringify } from 'yaml';
import { hash, AppError } from '../../config/src/index.ts';
import { artifactSchema, type CacheArtifact } from './cache-artifact.ts';
import type { CacheChange, CacheField, CacheOperationView } from '../../contracts/src/execution-cache.ts';

const locatorKeys = new Set(['aiTap', 'aiHover', 'aiDoubleClick', 'aiRightClick', 'locate']);
type Slot = CacheField & { set: (value: string) => void };
// Only existing locator fields are editable. Input values, action types, prompts
// used as cache keys, and assertion baselines never come from the editor.
function nativeSlots(native: any, prefix: string): Slot[] {
  const slots: Slot[] = [];
  for (const [i, entry] of (native?.caches ?? []).entries()) {
    if (entry?.type === 'locate' && Array.isArray(entry.cache?.xpaths)) {
      entry.cache.xpaths.forEach((value: unknown, j: number) => {
        if (typeof value === 'string')
          slots.push({
            path: `${prefix}.${i}.xpaths.${j}`,
            label: `定位 ${i + 1} · XPath ${j + 1}`,
            value,
            set: (v) => {
              entry.cache.xpaths[j] = v;
            },
          });
      });
    }
    if (entry?.type === 'plan' && typeof entry.yamlWorkflow === 'string') {
      try {
        const workflow = parse(entry.yamlWorkflow, { maxAliasCount: 0 });
        const walk = (obj: any, path: string) => {
          if (!obj || typeof obj !== 'object') return;
          for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'string' && locatorKeys.has(key)) {
              slots.push({
                path: `${prefix}.${i}.workflow.${path}${key}`,
                label: `规划 ${i + 1} · ${path}${key}`,
                value,
                set: (v) => {
                  obj[key] = v;
                  entry.yamlWorkflow = stringify(workflow);
                },
              });
            } else if (value && typeof value === 'object') walk(value, `${path}${key}.`);
          }
        };
        walk(workflow, '');
      } catch {
        /* Old SDK workflow remains readable as protected content. */
      }
    }
  }
  return slots;
}
function slotsFor(artifact: CacheArtifact, tier: 'L1' | 'L2'): Slot[] {
  return Object.entries(artifact.channels).flatMap(([phase, channel]) =>
    channel.operations.flatMap((op, i) => {
      const prefix = `${phase}.operations.${i}`;
      return tier === 'L1'
        ? nativeSlots(channel.nativeByOperation[op.key], `${prefix}.native`)
        : op.commands.map((command, j) => ({
            path: `${prefix}.commands.${j}.selector`,
            label: `操作 ${j + 1} · CSS 定位`,
            value: command.selector,
            set: (v: string) => {
              command.selector = v;
              if (command.target) command.target = { by: 'css', value: v };
            },
          }));
    }),
  );
}
function safeNative(native: any) {
  const safeWorkflow = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return locatorKeys.has(key) ? value : '（受保护内容）';
    if (Array.isArray(value)) return value.map((v) => safeWorkflow(v, key));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safeWorkflow(v, k)]));
    return value;
  };
  return (native?.caches ?? []).map((entry: any) => ({
    type: entry?.type ?? 'unknown',
    ...(entry?.type === 'locate' ? { xpaths: entry.cache?.xpaths ?? [] } : {}),
    ...(entry?.type === 'plan'
      ? {
          workflow: (() => {
            try {
              return safeWorkflow(parse(entry.yamlWorkflow, { maxAliasCount: 0 }));
            } catch {
              return '旧版本规划内容不可解析';
            }
          })(),
        }
      : {}),
    context: '匹配上下文与输入数据受保护，执行时由用例和登录配置提供',
  }));
}
export function cacheViews(artifact: CacheArtifact, tier: 'L1' | 'L2'): CacheOperationView[] {
  const slots = slotsFor(artifact, tier);
  return Object.entries(artifact.channels).flatMap(([phase, channel]) =>
    channel.operations.map((op, index) => {
      const fields = slots.filter((s) => s.path.startsWith(`${phase}.operations.${index}.`));
      const content =
        tier === 'L1'
          ? safeNative(channel.nativeByOperation[op.key])
          : {
              kind: op.kind,
              complete: op.complete,
              validation:
                artifact.version === 'weui-execution-cache-3'
                  ? op.check
                    ? '按本次用例预期重新验证'
                    : op.commands.length
                      ? '目标语义 + 本次输入参数；业务结果另行断言'
                      : 'Midscene 实时验证（不复用历史通过结果）'
                  : '旧版页面指纹校验，升级后需要重新生成',
              commands: op.commands.map((c) => ({
                kind: c.kind,
                ...(c.selectBy ? { selectBy: c.selectBy } : {}),
                ...(c.checked !== undefined ? { checked: c.checked } : {}),
                ...(c.key ? { key: c.key } : {}),
                selector: c.selector,
                ...(c.target ? { target: c.target, guard: c.guard } : {}),
                ...(['Input', 'Select'].includes(c.kind)
                  ? { input: c.runtimeInput ? '从本次用例或登录配置注入' : '受保护的固定输入' }
                  : {}),
                before: c.before,
              })),
              before: op.before,
              after: op.after,
              ...(op.check ? { check: op.check } : {}),
              ...(op.learning ? { learning: op.learning } : {}),
              ...(op.passed !== undefined ? { passed: op.passed } : {}),
            };
      return {
        phase,
        index,
        key: op.key,
        kind: op.kind,
        label: op.label ?? `${op.kind} · 操作 ${index + 1}`,
        complete: op.complete,
        content: JSON.stringify(content, null, 2),
        fields: fields.map(({ set, ...f }) => f),
      };
    }),
  );
}
export function editCache(
  artifact: CacheArtifact,
  tier: 'L1' | 'L2',
  edits: { path: string; value: string }[],
) {
  const next = structuredClone(artifact),
    slots = slotsFor(next, tier);
  if (new Set(edits.map((e) => e.path)).size !== edits.length)
    throw new AppError('CACHE_EDIT', '不能重复修改同一字段');
  for (const edit of edits) {
    const slot = slots.find((s) => s.path === edit.path);
    if (!slot || !edit.value.trim() || edit.value.length > 4000)
      throw new AppError('CACHE_EDIT', '只能修改已列出的定位字段，基线和输入数据不可改写');
    if (edit.path.includes('.xpaths.') && !/^(?:\/|\.{1,2}\/|\(|id\s*\()/.test(edit.value.trim()))
      throw new AppError(
        'CACHE_EDIT',
        '一级定位需要 XPath 路径，例如 //*[@id="query"]；CSS 定位请在二级缓存中修改',
      );
    slot.set(edit.value.trim());
  }
  if (!edits.some((e) => slots.find((s) => s.path === e.path)?.value !== e.value.trim())) return next;
  // Manual changes require rechecking the original case expectations. Explicit
  // structured oracles run directly; learned visual bindings need Midscene.
  for (const channel of Object.values(next.channels))
    for (const op of channel.operations) {
      if (tier === 'L1' || ['wait', 'assert'].includes(op.kind)) op.complete = false;
    }
  next.edited = true;
  return artifactSchema.parse(next);
}
function flatten(value: unknown, path = '', result: Record<string, unknown> = {}) {
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) result[path] = Array.isArray(value) ? '[]' : '{}';
    for (const [k, v] of entries) flatten(v, path ? `${path}.${k}` : k, result);
  } else result[path] = value;
  return result;
}
export function cacheChanges(before: CacheArtifact, after: CacheArtifact): CacheChange[] {
  const changes: CacheChange[] = [];
  for (const tier of ['L1', 'L2'] as const) {
    const view = (a: CacheArtifact) =>
      Object.fromEntries(
        cacheViews(a, tier).map((v) => {
          const content = JSON.parse(v.content);
          if (tier === 'L2' && a.version === 'weui-execution-cache-3') {
            // Screenshots/DOM hashes remain diagnostic evidence; changes to
            // them are not changes to the executable semantic contract.
            delete content.before;
            delete content.after;
            for (const command of content.commands ?? []) delete command.before;
          }
          return [`${v.phase}.operations.${v.index}`, content];
        }),
      );
    const a = flatten(view(before)),
      b = flatten(view(after));
    for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[path]) === JSON.stringify(b[path])) continue;
      changes.push({
        tier,
        path,
        before: a[path] === undefined ? '（无）' : String(a[path]),
        after: b[path] === undefined ? '（删除）' : String(b[path]),
      });
    }
    if (tier === 'L1')
      for (const [phase, channel] of Object.entries(after.channels))
        channel.operations.forEach((op, i) => {
          const old = before.channels[phase]?.nativeByOperation[op.key],
            next = channel.nativeByOperation[op.key];
          if (
            hash(old ?? null) !== hash(next ?? null) &&
            !changes.some((c) => c.tier === 'L1' && c.path.startsWith(`${phase}.operations.${i}.`))
          )
            changes.push({
              tier,
              path: `${phase}.operations.${i}.protectedContext`,
              before: '受保护的上下文/规划',
              after: '内容已更新（不显示输入数据）',
            });
        });
  }
  return changes;
}
