import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t bg-muted/50">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p className="font-semibold">
          For emergencies call{" "}
          <a href="tel:000" className="underline underline-offset-2">
            000
          </a>
          .
        </p>
        <nav aria-label="Footer" className="flex gap-4 text-muted-foreground">
          <Link href="/privacy" className="hover:underline">
            Privacy and recording consent
          </Link>
        </nav>
      </div>
    </footer>
  );
}
