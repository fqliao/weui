'use client';
import { browserLabels, type BrowserName } from '../../../packages/contracts/src/browser-choice';

export function BrowserSelect({
  id,
  value,
  onChange,
  disabled,
  label = '测试浏览器',
  compact = false,
}: {
  id: string;
  value: BrowserName;
  onChange: (value: BrowserName) => void;
  disabled?: boolean;
  label?: string;
  compact?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as BrowserName)}
        aria-describedby={compact ? undefined : `${id}-help`}
      >
        <option value="chrome">{browserLabels.chrome}（默认）</option>
        <option value="edge">{browserLabels.edge}</option>
        <option value="firefox">{browserLabels.firefox}</option>
      </select>
      {!compact && (
        <small id={`${id}-help`} className="muted">
          使用执行服务器上的浏览器，运行后保留本次选择供回归。
        </small>
      )}
    </div>
  );
}
