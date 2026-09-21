import { cn } from '@/lib/utils';

interface AurumMarkProps {
  className?: string;
  title?: string;
}

/** Compact brand mark designed to remain legible at favicon size. */
export function AurumMark({ className, title }: AurumMarkProps) {
  const labelled = Boolean(title);

  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('block shrink-0', className)}
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="2" y="2" width="28" height="28" rx="7" fill="#2563eb" />
      <path d="M7.5 24 13.7 8h4.6l6.2 16h-4.1l-4.6-12.5L11.2 24H7.5Z" fill="#f8fafc" />
      <path d="M12 18.3h8l1.3 3.4h-10.6l1.3-3.4Z" fill="#fbbf24" />
    </svg>
  );
}
