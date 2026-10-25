/** Brand mark: hexagon with a central node linked to three satellites. Mirrors public/favicon.svg. */
export default function NexusLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Nexus IoT Platform">
      <defs>
        <linearGradient id="nexusGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2AA8FF" />
          <stop offset="1" stopColor="#0B3D91" />
        </linearGradient>
      </defs>
      <path d="M32 3 56.2 17v30L32 61 7.8 47V17z" fill="url(#nexusGrad)" stroke="#fff" strokeOpacity=".35" strokeWidth="1.5" />
      <path d="M32 32V16M32 32 18.5 40M32 32l13.5 8" stroke="#fff" strokeWidth="3" strokeLinecap="round" fill="none" />
      <circle cx="32" cy="32" r="6" fill="#fff" />
      <circle cx="32" cy="14.5" r="3.6" fill="#fff" />
      <circle cx="17" cy="40.8" r="3.6" fill="#fff" />
      <circle cx="47" cy="40.8" r="3.6" fill="#fff" />
    </svg>
  );
}
