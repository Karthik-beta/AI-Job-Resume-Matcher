import { cn } from "cn";
import Link from "next/link";

// The mark is a check over a highlighter stroke, like the highlighted reasons on a match.
// Same drawing as app/icon.svg.
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-7 shrink-0", className)}>
      <rect width="32" height="32" rx="7" fill="var(--primary)" />
      <path d="M7.5 22h17" stroke="var(--highlight)" strokeWidth="5" strokeLinecap="round" />
      <path
        d="M9 15.5l5 5 9.5-11"
        fill="none"
        stroke="var(--primary)"
        strokeWidth="6.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 15.5l5 5 9.5-11"
        fill="none"
        stroke="var(--primary-foreground)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
