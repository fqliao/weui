'use client';
import { useEffect, useState } from 'react';
import { api, post, date, type Run, type User } from './api';
import type { Notify } from './workbench';
import type {
  ModelCharge,
  ModelPrice,
  ModelTarget,
  PriceBook,
  TokenRate,
} from '../../../packages/contracts/src/pricing';
type PricingData = {
  book: PriceBook;
  targets: { planner: ModelTarget; vision: ModelTarget };
  official: ModelPrice;
};

export function PricingSettings({ user, notify }: { user: User; notify: Notify }) {
  const [data, setData] = useState<PricingData | null>(null),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    api<PricingData>('/model-pricing')
      .then(setData)
      .catch((e) => notify(e.message, true));
  }, []);
  if (!data) return <section className="panel form-panel">正在读取模型价格…</section>;
  const targets = Object.values(data.targets).filter(
    (t, i, all) => t.model && all.findIndex((o) => o.model === t.model && o.baseUrl === t.baseUrl) === i,
  );
  function replace(row: ModelPrice) {
    setData(
      (d) =>
        d && {
          ...d,
          book: {
            ...d.book,
            models: [...d.book.models.filter((p) => p.model !== row.model || p.baseUrl !== row.baseUrl), row],
          },
        },
    );
    setDirty(true);
  }
  return (
    <section className="panel form-panel pricing-settings">
      <h2>模型价格</h2>
      <p>平台共用 · 人民币（元）/ 百万 Token。新运行会保存价格快照，历史运行不会被改价。</p>
      <p className="muted">
        高峰：北京时间周一至周五 09:00–12:00、14:00–18:00，其余为空闲时段。缓存明细缺失时按未命中估算。
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            setData(
              await post<PricingData>('/admin/model-pricing', {
                updatedAt: data.book.updatedAt,
                models: data.book.models,
              }),
            );
            setDirty(false);
            notify('模型价格已保存，新运行将使用此价格');
          } catch (e) {
            notify((e as Error).message, true);
          } finally {
            setBusy(false);
          }
        }}
      >
        {targets.map((target) => {
          const configuredRow = data.book.models.find(
            (p) => p.model === target.model && p.baseUrl === target.baseUrl,
          );
          const row = configuredRow?.currency === 'CNY' ? configuredRow : undefined;
          const supported =
            target.baseUrl === data.official.baseUrl &&
            ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(target.model);
          return (
            <fieldset
              className="price-model"
              key={target.model + target.baseUrl}
              disabled={user.role !== 'ADMIN' || busy}
            >
              <legend>{target.model}</legend>
              <p className="muted">
                {target.baseUrl || '服务地址未配置'} ·{' '}
                {Object.entries(data.targets)
                  .filter(([, t]) => t.model === target.model && t.baseUrl === target.baseUrl)
                  .map(([r]) => (r === 'planner' ? '规划模型' : '视觉模型'))
                  .join(' / ')}
              </p>
              {row ? (
                <>
                  <div className="price-table-wrap">
                    <table className="price-table">
                      <thead>
                        <tr>
                          <th>时段</th>
                          <th>输入（未命中）</th>
                          <th>输入（缓存命中）</th>
                          <th>输出</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(['peak', ...(row.offPeak ? ['offPeak'] : [])] as ('peak' | 'offPeak')[]).map(
                          (period) => (
                            <tr key={period}>
                              <th>{row.offPeak ? (period === 'peak' ? '高峰' : '空闲') : '全天'}</th>
                              {(['input', 'cacheRead', 'output'] as (keyof TokenRate)[]).map((key) => (
                                <td key={key}>
                                  <input
                                    aria-label={`${target.model} ${period} ${key}`}
                                    type="number"
                                    min="0"
                                    max="10000"
                                    step="any"
                                    required
                                    value={row[period]![key]}
                                    onChange={(e) =>
                                      replace({
                                        ...row,
                                        [period]: { ...row[period], [key]: Number(e.target.value) },
                                        source: 'manual',
                                      })
                                    }
                                  />
                                </td>
                              ))}
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                  <label className="price-schedule">
                    <input
                      type="checkbox"
                      checked={!!row.offPeak}
                      onChange={(e) => {
                        const { offPeak: _, ...flat } = row;
                        replace(
                          e.target.checked
                            ? { ...row, offPeak: { ...row.peak }, source: 'manual' }
                            : { ...flat, source: 'manual' },
                        );
                      }}
                    />
                    按上述高峰 / 空闲时段分别计价
                  </label>
                  <p className="price-source">
                    {row.source === 'official'
                      ? '官方定价快照'
                      : row.source === 'environment'
                        ? '环境变量导入'
                        : '管理员自定义'}{' '}
                    · {row.verifiedAt}
                    {row.sourceUrl && (
                      <>
                        {' '}
                        ·{' '}
                        <a href={row.sourceUrl} target="_blank" rel="noreferrer">
                          查看定价来源
                        </a>
                      </>
                    )}
                  </p>
                </>
              ) : (
                <p>
                  {configuredRow ? '原美元报价已归档保留，请录入人民币单价。' : '尚未配置人民币价格。'}
                  <button
                    type="button"
                    className="button outline small"
                    onClick={() =>
                      replace({
                        ...target,
                        currency: 'CNY',
                        peak: { input: 0, cacheRead: 0, output: 0 },
                        source: 'manual',
                        sourceUrl: '',
                        verifiedAt: new Date().toISOString().slice(0, 10),
                      })
                    }
                  >
                    添加价格
                  </button>
                </p>
              )}
              {supported && user.role === 'ADMIN' && (
                <button
                  className="button outline small"
                  type="button"
                  onClick={() => replace({ ...data.official, ...target })}
                >
                  使用已核验的官方价格（{data.official.verifiedAt}）
                </button>
              )}
            </fieldset>
          );
        })}
        <div className="form-footer">
          <small className="muted">
            更新于 {date(data.book.updatedAt)} · 官方价格为核验快照，未开启定时同步。
          </small>
          {user.role === 'ADMIN' && (
            <button className="button primary" disabled={busy || !dirty}>
              保存模型价格
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

type Cost = {
  status: string;
  costCny: number | null;
  models: string[];
  notes: string[];
  sources: string[];
  rows?: ModelCharge[];
};
export function RunCost({ run }: { run: Run }) {
  const [data, setData] = useState<Cost | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Cost>(`/runs/${run.id}/cost`)
      .then((d) => {
        if (active) {
          setData(d);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [run.id, run.usage.inputTokens, run.usage.outputTokens, run.status]);
  return (
    <div className="run-cost">
      <small>{data?.status === 'reference' ? '历史费用参考' : '估算模型费用'}</small>
      <strong>
        {error
          ? '费用读取失败'
          : !data
            ? '正在计算…'
            : data.costCny === null
              ? '暂无法估算'
              : data.status === 'unused'
                ? '¥0 · 未调用模型'
                : `${data.status === 'partial' ? '已知部分 ' : '约 '}¥${data.costCny.toFixed(5)}`}
      </strong>
      <span className="muted">
        人民币 · <a href="#/settings">价格设置</a>
      </span>
      {error && <p className="text-danger">{error}</p>}
      {data && (
        <details className="cost-explanation">
          <summary>计价说明</summary>
          {data.models.length > 0 && <p>{data.models.join(' / ')}</p>}
          {data.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
          {data.rows?.length ? (
            <p>
              输入 {data.rows.reduce((n, r) => n + r.inputTokens, 0).toLocaleString()} / 输出{' '}
              {data.rows.reduce((n, r) => n + r.outputTokens, 0).toLocaleString()} Token；价格核验日期{' '}
              {[...new Set(data.rows.map((r) => r.verifiedAt).filter(Boolean))].join('、') || '未配置'}。
            </p>
          ) : null}
          {data.sources.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">
              定价来源 ↗
            </a>
          ))}
        </details>
      )}
    </div>
  );
}
