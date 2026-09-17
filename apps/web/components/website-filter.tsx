'use client';
import type { Website } from './websites';

export function WebsiteFilter({
  sites,
  value,
  onChange,
  history,
  onHistory,
  all = true,
}: {
  sites: Pick<Website, 'id' | 'name' | 'enabled'>[];
  value: string;
  onChange: (id: string) => void;
  history: boolean;
  onHistory: (value: boolean) => void;
  all?: boolean;
}) {
  return (
    <div className="website-filter">
      <label>
        测试网站
        <select aria-label="测试网站" value={value} onChange={(e) => onChange(e.target.value)}>
          {all && <option value="">全部{history ? '' : '启用'}网站</option>}
          {!all && !value && <option value="">选择网站</option>}
          {sites
            .filter((s) => s.enabled || history || s.id === value)
            .map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
                {s.enabled ? '' : '（已停用）'}
              </option>
            ))}
        </select>
      </label>
      <label className="inline-check">
        <input type="checkbox" checked={history} onChange={(e) => onHistory(e.target.checked)} />
        包含已停用网站
      </label>
    </div>
  );
}
