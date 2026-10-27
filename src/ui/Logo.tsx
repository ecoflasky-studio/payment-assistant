/** 账期助手图标（紫色渐变 + 白色票据 + 黄色对勾），与 App 图标一致 */
export function Logo({ size = 28 }: { size?: number }) {
  const id = `lg${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6a4bff" />
          <stop offset="1" stopColor="#9a5cf6" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill={`url(#${id})`} />
      <path d="M9.4 7.2h13.2a1.1 1.1 0 0 1 1.1 1.1v16.1l-2-1.3-2.1 1.3-2-1.3-2.1 1.3-2-1.3-2.1 1.3-2-1.3V8.3a1.1 1.1 0 0 1 1-1.1z" fill="#fff" />
      <rect x="11.1" y="11" width="7.8" height="1.6" rx=".8" fill="#5b3df5" />
      <rect x="11.1" y="14.2" width="5.3" height="1.6" rx=".8" fill="#c9bfff" />
      <circle cx="23.2" cy="8.2" r="3.6" fill="#ffd94d" stroke="#fff" strokeWidth="1" />
    </svg>
  );
}
