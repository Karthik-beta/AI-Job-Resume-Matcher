"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function HeaderNav() {
  const { data: session } = authClient.useSession();

  return session ? (
    <Link href="/settings" className={buttonVariants({ variant: "outline" })}>
      Settings
    </Link>
  ) : (
    <Link href="/sign-in" className={buttonVariants({ variant: "outline" })}>
      Sign in
    </Link>
  );
}
