export default function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
      <defs>
        <linearGradient id="memeit-logo-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#343b25" />
          <stop offset="1" stopColor="#0c0c09" />
        </linearGradient>
        <clipPath id="memeit-logo-slat">
          <rect x="12" y="15" width="44" height="8" rx="2" />
        </clipPath>
        <filter id="memeit-logo-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" floodColor="#000000" floodOpacity="0.4" />
        </filter>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#memeit-logo-bg)" />
      <ellipse cx="24" cy="12" rx="26" ry="12" fill="#ffffff" opacity="0.07" />
      <g filter="url(#memeit-logo-soft)">
        <g transform="rotate(-10 12 24)">
          <g clipPath="url(#memeit-logo-slat)">
            <rect x="12" y="15" width="44" height="8" fill="#f4f1e8" />
            <polygon points="12,15 19.3,15 22.3,23 15,23" fill="#14160e" />
            <polygon points="26.7,15 34,15 37,23 29.7,23" fill="#14160e" />
            <polygon points="41.3,15 48.7,15 51.7,23 44.3,23" fill="#14160e" />
          </g>
          <rect x="12" y="15" width="44" height="8" rx="2" fill="none" stroke="#14160e" strokeWidth="2" />
        </g>
        <rect x="12" y="25" width="40" height="27" rx="4" fill="#f4f1e8" stroke="#14160e" strokeWidth="2.5" />
        <circle cx="12" cy="24.5" r="3" fill="#14160e" />
        <circle cx="12" cy="24.5" r="1.2" fill="#f4f1e8" />
        <rect x="16" y="31" width="11" height="5" rx="1.5" fill="#5b8cff" />
        <rect x="29" y="31" width="15" height="5" rx="1.5" fill="#9b7ff7" />
        <rect x="16" y="39" width="9" height="5" rx="1.5" fill="#f7b84f" />
        <rect x="27" y="39" width="17" height="5" rx="1.5" fill="#4fd78a" />
        <line x1="34" y1="29" x2="34" y2="46" stroke="#ff5b5b" strokeWidth="1.5" />
        <polygon points="31.5,29 36.5,29 34,32" fill="#ff5b5b" />
      </g>
    </svg>
  );
}
