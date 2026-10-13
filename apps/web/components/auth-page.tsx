import { AuthForm } from "@/components/auth-form";
import { Logo } from "@/components/logo";

export function AuthPage({ mode }: { mode: "sign-in" | "sign-up" }) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 sm:px-8">
      <header className="py-6">
        <Logo href="/" />
      </header>
      <main className="flex flex-1 flex-col pt-10 pb-24 lg:pt-16">
        <AuthForm mode={mode} />
      </main>
    </div>
  );
}
