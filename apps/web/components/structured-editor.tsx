'use client';
import type { WebStep } from '../../../packages/contracts/src/browser';
import {
  conditionNames,
  keySchema,
  type UiTarget,
  type UiCondition,
  type UiConditionLeaf,
  type WebAssertion,
} from '../../../packages/contracts/src/static-ui';
import { stepCapability, assertionCapability } from '../../../packages/contracts/src/static-capability';

const roleNames = [
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'option',
  'tab',
  'menuitem',
  'heading',
  'alert',
  'dialog',
  'row',
  'cell',
  'listitem',
] as const;
const emptyTarget: UiTarget = { by: 'label', value: '' };
export function TargetEditor({
  value,
  onChange,
  label,
}: {
  value: UiTarget;
  onChange: (v: UiTarget) => void;
  label: string;
}) {
  return (
    <div className="target-editor">
      <select
        aria-label={`${label} 定位方式`}
        value={value.by}
        onChange={(e) =>
          onChange({
            by: e.target.value as UiTarget['by'],
            value: value.value,
            ...(e.target.value === 'role' ? { role: 'button' as const } : {}),
          })
        }
      >
        <option value="label">字段标签</option>
        <option value="role">角色与名称</option>
        <option value="text">可见文本</option>
        <option value="placeholder">占位提示</option>
        <option value="testId">测试 ID</option>
        <option value="css">CSS（高级）</option>
      </select>
      {value.by === 'role' && (
        <select
          aria-label={`${label} 角色`}
          value={value.role || 'button'}
          onChange={(e) => onChange({ ...value, role: e.target.value as UiTarget['role'] })}
        >
          {roleNames.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      )}
      <input
        required
        aria-label={`${label} 定位内容`}
        value={value.value}
        onChange={(e) => onChange({ ...value, value: e.target.value })}
        placeholder={
          value.by === 'label'
            ? '例如：用户名（可见字段标签）'
            : value.by === 'css'
              ? '例如：[data-testid="submit"]'
              : '精确匹配，可使用 {{data.name}}'
        }
      />
    </div>
  );
}
export function blankCondition(kind: UiCondition['kind']): UiCondition {
  if (kind === 'all' || kind === 'any')
    return { kind, conditions: [{ kind: 'visible', target: { ...emptyTarget } }] };
  if (kind === 'url') return { kind, expected: '', match: 'contains' };
  if (kind === 'text') return { kind, target: { ...emptyTarget }, expected: '', match: 'contains' };
  if (kind === 'value') return { kind, target: { ...emptyTarget }, expected: '' };
  if (kind === 'checked') return { kind, target: { ...emptyTarget }, checked: true };
  if (kind === 'position') return { kind, target: { ...emptyTarget }, region: 'top-right' };
  if (kind === 'count') return { kind, target: { ...emptyTarget }, count: 1 };
  return { kind, target: { ...emptyTarget } };
}
export function ConditionEditor({
  value,
  onChange,
  label,
  leaf = false,
}: {
  value: UiCondition;
  onChange: (v: UiCondition) => void;
  label: string;
  leaf?: boolean;
}) {
  return (
    <div className="condition-editor">
      <select
        aria-label={`${label} 条件`}
        value={value.kind}
        onChange={(e) => onChange(blankCondition(e.target.value as UiCondition['kind']))}
      >
        {Object.entries(conditionNames).map(([k, v]) => (
          <option value={k} key={k}>
            {v}
          </option>
        ))}
        {!leaf && (
          <>
            <option value="all">全部条件满足（AND）</option>
            <option value="any">任一条件满足（OR）</option>
          </>
        )}
      </select>
      {'conditions' in value ? (
        <div className="condition-group">
          {value.conditions.map((c, i) => (
            <div key={i}>
              <ConditionEditor
                leaf
                label={`${label} 子条件 ${i + 1}`}
                value={c}
                onChange={(v) =>
                  onChange({
                    ...value,
                    conditions: value.conditions.map((old, j) => (j === i ? (v as UiConditionLeaf) : old)),
                  })
                }
              />
              <button
                type="button"
                className="text-link"
                disabled={value.conditions.length <= 1}
                onClick={() => onChange({ ...value, conditions: value.conditions.filter((_, j) => i !== j) })}
              >
                删除子条件
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button outline"
            disabled={value.conditions.length >= 10}
            onClick={() =>
              onChange({
                ...value,
                conditions: [...value.conditions, { kind: 'visible', target: { ...emptyTarget } }],
              })
            }
          >
            添加子条件
          </button>
        </div>
      ) : (
        <>
          {'target' in value && (
            <TargetEditor
              label={label}
              value={value.target}
              onChange={(target) => onChange({ ...value, target })}
            />
          )}
          {'match' in value && (
            <select
              aria-label={`${label} 匹配关系`}
              value={value.match}
              onChange={(e) => onChange({ ...value, match: e.target.value as 'equals' | 'contains' })}
            >
              <option value="contains">包含</option>
              <option value="equals">完全相等</option>
            </select>
          )}
          {'expected' in value && (
            <input
              aria-label={`${label} 预期值`}
              value={value.expected}
              onChange={(e) => onChange({ ...value, expected: e.target.value })}
              placeholder="预期值，可使用 {{data.name}} / {{runId}}"
            />
          )}
          {value.kind === 'checked' && (
            <select
              aria-label={`${label} 勾选状态`}
              value={String(value.checked)}
              onChange={(e) => onChange({ ...value, checked: e.target.value === 'true' })}
            >
              <option value="true">已勾选</option>
              <option value="false">未勾选</option>
            </select>
          )}
          {value.kind === 'position' && (
            <select
              aria-label={`${label} 页面位置`}
              value={value.region}
              onChange={(e) => onChange({ ...value, region: e.target.value as typeof value.region })}
            >
              <option value="top-left">左上（上方三分之一区域）</option>
              <option value="top-right">右上（上方三分之一区域）</option>
              <option value="bottom-left">左下（下方三分之一区域）</option>
              <option value="bottom-right">右下（下方三分之一区域）</option>
            </select>
          )}
          {value.kind === 'count' && (
            <input
              aria-label={`${label} 预期数量`}
              type="number"
              min={0}
              max={10000}
              required
              value={value.count}
              onChange={(e) => onChange({ ...value, count: Number(e.target.value) })}
            />
          )}
        </>
      )}
    </div>
  );
}
export function newStep(kind: WebStep['kind'], text = ''): WebStep {
  if (kind === 'input') return { kind, text, value: '' };
  if (kind === 'select') return { kind, text, value: '', selectBy: 'label' };
  if (kind === 'check') return { kind, text, checked: true };
  if (kind === 'press') return { kind, text, key: 'Enter' };
  return { kind, text };
}
export function StepEditor({
  label,
  steps,
  onChange,
}: {
  label: string;
  steps: WebStep[];
  onChange: (steps: WebStep[]) => void;
}) {
  const replace = (index: number, step: WebStep) => onChange(steps.map((s, i) => (i === index ? step : s)));
  return (
    <fieldset className="step-editor">
      <legend>{label}</legend>
      {steps.map((s, i) => {
        const name = `${label} ${i + 1}`,
          cap = stepCapability(s);
        return (
          <div className="structured-step" key={i}>
            <div className="structured-step-heading">
              <strong>{i + 1}</strong>
              <select
                aria-label={`${name} 类型`}
                value={s.kind}
                onChange={(e) => replace(i, newStep(e.target.value as WebStep['kind'], s.text))}
              >
                <option value="act">自然语言操作</option>
                <option value="tap">点击</option>
                <option value="input">输入 / 清空</option>
                <option value="select">下拉选择</option>
                <option value="check">勾选 / 取消 / 单选</option>
                <option value="hover">悬停</option>
                <option value="press">按键</option>
                <option value="wait">等待条件</option>
              </select>
              <button
                type="button"
                className="text-link"
                aria-label={`上移步骤 ${i + 1}`}
                disabled={i === 0}
                onClick={() => {
                  const a = [...steps];
                  [a[i - 1], a[i]] = [a[i], a[i - 1]];
                  onChange(a);
                }}
              >
                上移
              </button>
              <button
                type="button"
                className="text-link"
                aria-label={`下移步骤 ${i + 1}`}
                disabled={i === steps.length - 1}
                onClick={() => {
                  const a = [...steps];
                  [a[i + 1], a[i]] = [a[i], a[i + 1]];
                  onChange(a);
                }}
              >
                下移
              </button>
              <button
                type="button"
                className="text-link danger"
                aria-label={`删除步骤 ${i + 1}`}
                onClick={() => onChange(steps.filter((_, j) => j !== i))}
              >
                删除
              </button>
            </div>
            <input
              required
              aria-label={`${name} 描述`}
              value={s.text}
              onChange={(e) => replace(i, { ...s, text: e.target.value })}
              placeholder="描述目标控件和操作目的"
            />
            {'value' in s && (
              <input
                aria-label={`${name} 输入值`}
                value={s.value}
                onChange={(e) => replace(i, { ...s, value: e.target.value })}
                placeholder="值或 {{data.name}}；输入留空表示清空"
              />
            )}
            {s.kind === 'select' && (
              <select
                aria-label={`${name} 选项匹配`}
                value={s.selectBy}
                onChange={(e) => replace(i, { ...s, selectBy: e.target.value as 'label' | 'value' })}
              >
                <option value="label">按选项文本</option>
                <option value="value">按选项值</option>
              </select>
            )}
            {s.kind === 'check' && (
              <select
                aria-label={`${name} 操作状态`}
                value={String(s.checked)}
                onChange={(e) => replace(i, { ...s, checked: e.target.value === 'true' })}
              >
                <option value="true">勾选 / 选中</option>
                <option value="false">取消勾选</option>
              </select>
            )}
            {s.kind === 'press' && (
              <select
                aria-label={`${name} 按键`}
                value={s.key}
                onChange={(e) => replace(i, { ...s, key: e.target.value as typeof s.key })}
              >
                {keySchema.options.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            )}
            {s.kind !== 'act' && s.kind !== 'wait' && (
              <>
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={!!s.target}
                    onChange={(e) =>
                      replace(i, { ...s, target: e.target.checked ? { ...emptyTarget } : undefined })
                    }
                  />
                  指定控件定位，优先静态执行
                </label>
                {s.target && (
                  <TargetEditor
                    label={name}
                    value={s.target}
                    onChange={(target) => replace(i, { ...s, target })}
                  />
                )}
              </>
            )}
            {s.kind === 'wait' && (
              <>
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={!!s.condition}
                    onChange={(e) =>
                      replace(i, {
                        ...s,
                        condition: e.target.checked ? blankCondition('visible') : undefined,
                      })
                    }
                  />
                  使用结构化等待条件
                </label>
                {s.condition && (
                  <>
                    <ConditionEditor
                      label={name}
                      value={s.condition}
                      onChange={(condition) => replace(i, { ...s, condition })}
                    />
                    <label>
                      最长等待（毫秒）
                      <input
                        aria-label={`${name} 超时`}
                        type="number"
                        min={100}
                        max={30000}
                        value={s.timeoutMs ?? 20000}
                        onChange={(e) => replace(i, { ...s, timeoutMs: Number(e.target.value) })}
                      />
                    </label>
                  </>
                )}
              </>
            )}
            <small className={`execution-capability ${cap.level}`} title={cap.reason}>
              {cap.label} · {cap.reason}
            </small>
          </div>
        );
      })}
      <button
        type="button"
        className="button outline"
        disabled={steps.length >= (label === '清理步骤' ? 10 : 30)}
        onClick={() => onChange([...steps, newStep('tap')])}
      >
        添加{label}
      </button>
    </fieldset>
  );
}
export function AssertionsEditor({
  value,
  onChange,
  title = '预期结果',
  maxItems = 15,
}: {
  value: WebAssertion[];
  onChange: (v: WebAssertion[]) => void;
  title?: string;
  maxItems?: number;
}) {
  const replace = (i: number, a: WebAssertion) => onChange(value.map((v, j) => (i === j ? a : v)));
  return (
    <fieldset className="step-editor">
      <legend>{title}</legend>
      {value.map((a, i) => {
        const cap = assertionCapability(a),
          label = `验证 ${i + 1}`;
        return (
          <div className="structured-step" key={i}>
            <div className="structured-step-heading">
              <strong>{label}</strong>
              <select
                aria-label={`${label} 验证方式`}
                value={typeof a === 'string' ? 'ai' : 'structured'}
                onChange={(e) =>
                  replace(
                    i,
                    e.target.value === 'ai' ? '' : { kind: 'structured', condition: blankCondition('text') },
                  )
                }
              >
                <option value="ai">自然语言判断</option>
                <option value="structured">结构化验证</option>
              </select>
              <button
                type="button"
                className="text-link danger"
                disabled={value.length <= 1}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                删除验证
              </button>
            </div>
            {typeof a === 'string' ? (
              <textarea
                required
                aria-label={`${label} 描述`}
                value={a}
                onChange={(e) => replace(i, e.target.value)}
                placeholder="描述完整业务预期；需要实时视觉判断的条件保留自然语言"
              />
            ) : (
              <>
                <ConditionEditor
                  label={label}
                  value={a.condition}
                  onChange={(condition) => replace(i, { ...a, condition })}
                />
                <label>
                  验证超时（毫秒）
                  <input
                    aria-label={`${label} 超时`}
                    type="number"
                    min={100}
                    max={30000}
                    value={a.timeoutMs ?? 5000}
                    onChange={(e) => replace(i, { ...a, timeoutMs: Number(e.target.value) })}
                  />
                </label>
              </>
            )}
            <small className={`execution-capability ${cap.level}`}>
              {cap.label} · {cap.reason}
            </small>
          </div>
        );
      })}
      <button
        type="button"
        className="button outline"
        hidden={maxItems === 1}
        disabled={value.length >= maxItems}
        onClick={() => onChange([...value, { kind: 'structured', condition: blankCondition('text') }])}
      >
        添加验证
      </button>
      <p className="muted">结构化条件每次重新验证；真实失败不会由 AI 放宽预期。后台业务结论仍需独立证据。</p>
    </fieldset>
  );
}
export function ParametersEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const entries = Object.entries(value);
  return (
    <fieldset className="step-editor">
      <legend>测试数据参数</legend>
      <p className="muted">
        在输入、定位、等待或预期中使用 {'{{data.name}}'}。参数值可包含 {'{{runId}}'} / {'{{caseId}}'}
        。账号凭据请使用登录配置。
      </p>
      {entries.map(([name, v], i) => (
        <div className="parameter-row" key={i}>
          <input
            required
            pattern="[A-Za-z][A-Za-z0-9_]*"
            aria-label={`参数 ${i + 1} 名称`}
            value={name}
            onChange={(e) => {
              const next = e.target.value;
              if (entries.some(([k], j) => j !== i && k === next)) return;
              onChange(Object.fromEntries(entries.map((entry, j) => (j === i ? [next, v] : entry))));
            }}
          />
          <input
            aria-label={`参数 ${i + 1} 值`}
            value={v}
            onChange={(e) => onChange({ ...value, [name]: e.target.value })}
          />
          <button
            type="button"
            className="text-link danger"
            onClick={() => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)))}
          >
            删除参数
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button outline"
        disabled={entries.length >= 30}
        onClick={() => {
          let n = entries.length + 1;
          while (Object.hasOwn(value, `data${n}`)) n++;
          onChange({ ...value, [`data${n}`]: '' });
        }}
      >
        添加参数
      </button>
    </fieldset>
  );
}
