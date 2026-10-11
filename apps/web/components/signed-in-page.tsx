"use client";

import { cn } from "cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { HeaderNav } from "@/components/header-nav";
import { authClient } from "@/lib/auth-client";

export function SignedInPage({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && !session) router.replace("/sign-in");
  }, [isPending, session, router]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 sm:px-8">
      <header className="flex items-center justify-between py-6">
        <Link href="/" className="text-lg font-bold tracking-tight">
          Job Matcher
        </Link>
        <nav className="flex items-center gap-1">
          <HeaderNav />
        </nav>
      </header>
      <main className={cn("flex max-w-2xl flex-col gap-10 pt-10 pb-24 lg:pt-16", className)}>
        <h1 className="text-4xl font-extrabold tracking-[-0.03em]">{title}</h1>
        {session && children}
      </main>
    </div>
  );
}
