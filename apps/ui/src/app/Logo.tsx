/** Chef PDF mark: a document with a folded corner and a chef-hat-like swirl. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo">
      <defs>
        <linearGradient id="chef-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f2734f" />
          <stop offset="1" stopColor="#d9412e" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#chef-logo-g)" />
      <path
        d="M11 8.5h7.5l4.5 4.5v10a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 10 23V10a1.5 1.5 0 0 1 1-1.5Z"
        fill="#fff"
        opacity="0.96"
      />
      <path
        d="M18.5 8.5V12a1 1 0 0 0 1 1H23"
        fill="none"
        stroke="#f6b4a3"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M13 17.2h6.5M13 20h4.5" stroke="#e5533d" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
