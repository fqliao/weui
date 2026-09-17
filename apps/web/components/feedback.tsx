'use client';
import { useEffect, useState } from 'react';
import { api, date } from './api';
import { Pagination } from './pagination';
type Feedback = {
  id: string;
  runId: string;
  rating: number;
  category: string;
  comment: string;
  createdAt: string;
  author: string;
  title: string;
};
export function FeedbackList({
  projectId,
  runId,
  refreshKey = 0,
}: {
  projectId: string;
  runId?: string;
  refreshKey?: number;
}) {
  const [page, setPage] = useState(1),
    [size, setSize] = useState(10),
    [category, setCategory] = useState(''),
    [data, setData] = useState<{ total: number; items: Feedback[] } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    setPage(1);
  }, [projectId, runId, refreshKey]);
  useEffect(() => {
    let active = true;
    setError('');
    setData(null);
    const query = new URLSearchParams({ projectId, page: String(page), size: String(size) });
    if (runId) query.set('runId', runId);
    if (category) query.set('category', category);
    api<{ total: number; items: Feedback[] }>(`/feedback?${query}`)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [projectId, runId, page, size, category, refreshKey]);
  return (
    <section className="panel form-panel feedback-records">
      <div className="form-footer feedback-heading">
        <div>
          <h2>{runId ? '本次运行的反馈' : '反馈记录'}</h2>
          <p>
            保存在本平台，由当前工作空间成员查看。不会自动发送邮件或提交外部工单，也不会自动修改测试结论。
          </p>
        </div>
        {!runId && (
          <select
            aria-label="筛选反馈类型"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部类型</option>
            {['体验反馈', '结论纠正', '知识问题', '工具故障'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        )}
        {runId && (
          <a className="button outline small" href="#/feedback">
            查看空间反馈
          </a>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : !data ? (
        <p>正在读取反馈…</p>
      ) : (
        <>
          {data.items.map((f) => (
            <article className="feedback-record" key={f.id}>
              <div className="feedback-meta">
                <strong>{f.category}</strong>
                <span>{f.rating} / 5</span>
                <span>{f.author}</span>
                <time>{date(f.createdAt)}</time>
              </div>
              {!runId && (
                <a href={`#/runs/${f.runId}`}>
                  {f.title} · 运行 {f.runId.slice(0, 8)} ↗
                </a>
              )}
              <p>{f.comment}</p>
            </article>
          ))}
          {!data.total && <p className="muted">暂无反馈记录。</p>}
          {data.total > 0 && (
            <Pagination
              total={data.total}
              page={page}
              size={size}
              label="反馈"
              onPage={setPage}
              onSize={(n) => {
                setSize(n);
                setPage(1);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
