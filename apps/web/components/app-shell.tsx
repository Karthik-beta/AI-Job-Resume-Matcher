"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ListChecks, LogOut, MenuIcon, Settings, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  Fragment,
  type ReactNode,
  Suspense,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Logo } from "@/components/logo";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth-client";
import { useRestoreOnboarding } from "@/lib/onboarding";
import { useOverview } from "@/lib/overview";
import { authHref } from "@/lib/safe-next";

type NavItem = { href: string; label: string; sections: string[] };

const navItems: NavItem[] = [
  { href: "/home", label: "Home", sections: ["/home"] },
  // A run is opened from Analyze, so its details page belongs to that section.
  { href: "/analyze", label: "Analyze", sections: ["/analyze", "/runs"] },
  { href: "/matches", label: "Matches", sections: ["/matches"] },
  { href: "/settings", label: "Settings", sections: ["/settings"] },
];

function isCurrent(item: NavItem, pathname: string | null) {
  return (
    pathname !== null &&
    item.sections.some((section) => pathname === section || pathname.startsWith(`${section}/`))
  );
}

// Where the guard sends signed-out visitors: the sign-in page, returning here afterwards.
function signInUrl() {
  return authHref("/sign-in", `${window.location.pathname}${window.location.search}`);
}

type SessionGate = {
  // `loading` while the session loads, while redirecting a signed-out visitor and while signing
  // out; `failed` when the session couldn't be checked, or a stale cookie couldn't be cleared.
  status: "loading" | "signed-in" | "failed";
  retry: () => void;
};

const SessionGateContext = createContext<SessionGate>({ status: "loading", retry: () => {} });

// Whether the guarded page may render. `AppPage` shows a skeleton while loading and a retry
// when the session check failed.
export function useSessionGate() {
  return use(SessionGateContext);
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session, isPending, error, refetch } = authClient.useSession();
  const [signingOut, setSigningOut] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);
  const redirecting = useRef(false);
  // Only a 401 means signed out. A failed check (API down, network, timeout) leaves the cookie
  // alone: the session may be perfectly valid.
  const checkFailed = !session && !isPending && error !== null && error.status !== 401;
  // The user the pages were rendered for. Another tab can sign in as someone else, and the
  // session can then change from one user to another without ever being empty.
  const userId = session?.user.id ?? null;
  const [shownUserId, setShownUserId] = useState<string | null>(null);
  // Goes up when the user changes, not on the first sign-in, so only a switch remounts the pages.
  const [accountSwitches, setAccountSwitches] = useState(0);

  useEffect(() => {
    if (userId === null || userId === shownUserId) return;
    // The previous user's cached data and form state must not reach the new user's pages, or a
    // save could write it to the new account.
    if (shownUserId !== null) {
      queryClient.clear();
      setAccountSwitches((count) => count + 1);
    }
    setShownUserId(userId);
  }, [userId, shownUserId, queryClient]);

  useEffect(() => {
    // Signing out empties the session too; that navigates to `/` instead of the sign-in page.
    if (isPending || session || checkFailed || clearFailed || signingOut || redirecting.current) {
      return;
    }
    redirecting.current = true;
    // The proxy only checks that a session cookie exists. An expired or revoked one is cleared
    // first, or the proxy would send the sign-in page straight back here, and round again.
    // If that fails the cookie stays, so the page offers a retry rather than loop.
    const failed = () => {
      redirecting.current = false;
      setClearFailed(true);
    };
    void authClient.signOut().then(({ error }) => {
      if (error) return failed();
      // The next user to sign in on this tab mustn't see this user's cached data.
      queryClient.clear();
      router.replace(signInUrl());
    }, failed);
  }, [isPending, session, checkFailed, clearFailed, signingOut, router, queryClient]);

  const gate: SessionGate = {
    status:
      session && userId === shownUserId
        ? "signed-in"
        : !session && (checkFailed || clearFailed)
          ? "failed"
          : "loading",
    retry: () => {
      if (clearFailed) setClearFailed(false);
      else void refetch();
    },
  };

  async function signOut() {
    setSigningOut(true);
    const { error } = await authClient.signOut();
    if (error) {
      setSigningOut(false);
      toast.error("Could not sign out. Try again.");
      return;
    }
    queryClient.clear();
    router.replace("/");
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 sm:px-8">
      <header className="flex items-center justify-between gap-4 py-6">
        <div className="flex items-center gap-6">
          <Logo href="/home" />
          <Suspense fallback={<PrimaryNav pathname={null} />}>
            <CurrentPrimaryNav />
          </Suspense>
        </div>
        <div className="flex items-center gap-1">
          <Suspense fallback={<MobileNav pathname={null} />}>
            <CurrentMobileNav />
          </Suspense>
          {session ? (
            <UserMenu
              name={session.user.name}
              email={session.user.email}
              signingOut={signingOut}
              onSignOut={signOut}
            />
          ) : (
            <Skeleton className="size-8 rounded-lg" />
          )}
        </div>
      </header>
      {/* The page segment always renders, so Next can validate it; `AppPage` gates its content. */}
      <SessionGateContext value={gate}>
        {/* Remounted when the user changes, so no page keeps state from the previous one. */}
        <Fragment key={accountSwitches}>{children}</Fragment>
      </SessionGateContext>
    </div>
  );
}

// `usePathname` sits inside Suspense so routes with dynamic params can still prerender the shell.
function CurrentPrimaryNav() {
  return <PrimaryNav pathname={usePathname()} />;
}

function CurrentMobileNav() {
  return <MobileNav pathname={usePathname()} />;
}

function PrimaryNav({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Primary" className="hidden items-center gap-1 sm:flex">
      {navItems.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isCurrent(item, pathname) ? "page" : undefined}
          className={buttonVariants({
            variant: "ghost",
            className: "aria-[current=page]:bg-muted aria-[current=page]:text-foreground",
          })}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

function MobileNav({ pathname }: { pathname: string | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" className="sm:hidden" />}
        aria-label="Open navigation"
      >
        <MenuIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {navItems.map((item) => (
          <DropdownMenuLinkItem
            key={item.href}
            render={<Link href={item.href} />}
            aria-current={isCurrent(item, pathname) ? "page" : undefined}
          >
            {item.label}
          </DropdownMenuLinkItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({
  name,
  email,
  signingOut,
  onSignOut,
}: {
  name: string;
  email: string;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const router = useRouter();
  const overview = useOverview();
  const restore = useRestoreOnboarding();
  // Until onboarding is completed the setup checklist can be brought back to the home page.
  const showSetupGuide = overview.data?.onboarding.completedAt === null;

  function openSetupGuide() {
    if (overview.data?.onboarding.dismissedAt === null) {
      router.push("/home");
      return;
    }
    restore.mutate(undefined, {
      onSuccess: () => router.push("/home"),
      onError: () => toast.error("Could not show the setup guide. Try again."),
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="max-w-48" />}
        aria-label={`Account menu for ${name}`}
      >
        <UserRound />
        <span className="hidden truncate sm:inline">{name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">{name}</span>
            <span className="truncate font-normal">{email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem render={<Link href="/settings" />}>
          <Settings />
          Settings
        </DropdownMenuLinkItem>
        {showSetupGuide && (
          <DropdownMenuItem disabled={restore.isPending} onClick={openSetupGuide}>
            <ListChecks />
            Setup guide
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={signingOut} onClick={onSignOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
