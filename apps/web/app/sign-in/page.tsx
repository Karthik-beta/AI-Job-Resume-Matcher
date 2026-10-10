import type { Metadata } from "next";
import { AuthPage } from "@/components/auth-page";

export const metadata: Metadata = { title: "Sign in | Job Matcher" };

export default function SignInPage() {
  return <AuthPage mode="sign-in" />;
}
