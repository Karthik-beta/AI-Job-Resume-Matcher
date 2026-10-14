import { cn } from "cn";
import Link from "next/link";

// The mark is a check drawn as two flat-cut highlighter strokes, like the highlighted reasons on a
// match. Where the strokes cross, the marker passes twice and the yellow deepens.
// Same drawing as app/icon.svg; docs/brand has the guidelines.
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={cn("size-7 shrink-0", className)}>
      <rect width="64" height="64" rx="14" fill="var(--primary)" />
      <path
        d="M8 30 19.73 48h14.94L22.93 30zm11.73 18L41.07 16H56L34.67 48z"
        fill="var(--highlight)"
      />
      <path d="M19.73 48h14.94l-7.39-11.33z" fill="var(--highlight-deep)" />
    </svg>
  );
}

export function Logo({ href }: { href: string }) {
  return (
    <Link href={href} className="flex items-center gap-2.5 text-lg font-bold tracking-tight">
      <LogoMark />
      Job Matcher
    </Link>
  );
}
