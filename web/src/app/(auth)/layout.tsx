import { HeartPulse } from "lucide-react";
import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="flex flex-1 flex-col items-center px-4 py-10">
      <Link href="/" className="mb-6 flex items-center gap-2 text-lg font-semibold">
        <HeartPulse className="size-6 text-primary" aria-hidden="true" />
        MediANZ
      </Link>
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}
