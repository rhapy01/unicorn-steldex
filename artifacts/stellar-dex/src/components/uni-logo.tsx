export function UniLogo({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M16 2C8.268 2 2 8.268 2 16s6.268 14 14 14 14-6.268 14-14S23.732 2 16 2Z"
        fill="#FF007A"
      />
      <path
        d="M10.5 19.5c1.8-3.5 3.5-5.5 5.5-6.8 2 1.3 3.7 3.3 5.5 6.8-1.8 1-3.8 1.7-5.5 1.7s-3.7-.7-5.5-1.7Z"
        fill="white"
      />
      <circle cx="13" cy="13.5" r="1.1" fill="white" />
      <circle cx="19" cy="13.5" r="1.1" fill="white" />
    </svg>
  );
}
