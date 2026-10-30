"use client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DataError } from "@/lib/data/api";

function isSignedOut(err: unknown) {
  return err instanceof DataError && (err.code === "PGRST301" || err.status === 401);
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: (count, err) => !isSignedOut(err) && count < 2,
          },
        },
        // No error tracker or console logging: errors may carry health data.
        queryCache: new QueryCache({
          onError: (err) => {
            if (isSignedOut(err)) window.location.assign("/login?reason=expired");
          },
        }),
        mutationCache: new MutationCache({}),
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        {children}
        <Toaster position="top-center" closeButton />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
