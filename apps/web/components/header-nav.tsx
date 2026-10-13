"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function HeaderNav() {
  const { data: session } = authClient.useSession();

  return session ? (
    <Link href="/home" className={buttonVariants({ variant: "outline" })}>
      Open app
    </Link>
  ) : (
    <Link href="/sign-in" className={buttonVariants({ variant: "outline" })}>
      Sign in
    </Link>
  );
}
