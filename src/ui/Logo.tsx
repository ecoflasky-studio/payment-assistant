/** 账期助手图标（票据 + 提醒红点） */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="8" fill="#ffffff" fillOpacity="0.14" />
      <path d="M9 8h14v17l-2.3-1.5L18.3 25 16 23.5 13.7 25l-2.4-1.5L9 25z" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
      <path d="M12.5 13h7M12.5 17h4.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <circle cx="23" cy="9" r="3.2" fill="#ff5d73" />
    </svg>
  );
}
