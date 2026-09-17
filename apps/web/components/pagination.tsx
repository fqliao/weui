'use client';
export function pageItems<T>(items: T[], page: number, size: number) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.max(1, Math.min(page, pages));
  return { items: items.slice((current - 1) * size, current * size), current, pages };
}
export function Pagination({
  total,
  page,
  size,
  onPage,
  onSize,
  label = '用例',
}: {
  total: number;
  page: number;
  size: number;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
  label?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / size)),
    current = Math.min(page, pages);
  return (
    <nav className="case-pagination" aria-label={`${label}分页`}>
      <span>
        共 {total} 条 · {total ? (current - 1) * size + 1 : 0}–{Math.min(current * size, total)} 条
      </span>
      <div className="button-group">
        <label>
          每页{' '}
          <select aria-label={`每页${label}数`} value={size} onChange={(e) => onSize(Number(e.target.value))}>
            {[10, 20, 50].map((n) => (
              <option key={n} value={n}>
                {n} 条
              </option>
            ))}
          </select>
        </label>
        <button className="button outline" disabled={current <= 1} onClick={() => onPage(current - 1)}>
          上一页
        </button>
        <span aria-live="polite">
          {current} / {pages}
        </span>
        <button className="button outline" disabled={current >= pages} onClick={() => onPage(current + 1)}>
          下一页
        </button>
      </div>
    </nav>
  );
}
