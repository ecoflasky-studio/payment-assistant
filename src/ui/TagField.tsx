import { useState } from 'react';
import { parseTags } from '../lib/insights';
import { IX } from './icons';

/** 标签输入：回车 / 逗号添加，点 × 删除；下面给出常用标签一键添加 */
export function TagField({ value, onChange, suggestions = [], id = 'f-tags' }: { value: string[]; onChange: (t: string[]) => void; suggestions?: string[]; id?: string }) {
  const [text, setText] = useState('');
  const has = (t: string) => value.some((x) => x.toLowerCase() === t.toLowerCase());
  const add = (raw: string) => {
    const next = [...value];
    for (const t of parseTags(raw)) if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
    onChange(next.slice(0, 12));
    setText('');
  };
  const rest = suggestions.filter((t) => !has(t)).slice(0, 8);
  return (
    <div className="field">
      <label htmlFor={id}>标签</label>
      <div className="tagbox" onClick={() => document.getElementById(id)?.focus()}>
        {value.map((t) => (
          <span key={t} className="tagchip">
            #{t}
            <button type="button" aria-label={`删除标签 ${t}`} onClick={(e) => (e.stopPropagation(), onChange(value.filter((x) => x !== t)))}>
              <IX width={12} height={12} />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          placeholder={value.length ? '' : '如：店铺A、年货、待报销（回车添加）'}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,，;；]/.test(v)) add(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              e.preventDefault();
              add(text);
            } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => text.trim() && add(text)}
        />
      </div>
      {rest.length > 0 && (
        <div className="tagsugg" aria-label="常用标签">
          {rest.map((t) => (
            <button key={t} type="button" onClick={() => add(t)}>
              + #{t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
