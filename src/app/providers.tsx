"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

let browserQueryClient: QueryClient | undefined;

// A fresh client per server render keeps requests isolated; the browser reuses one so its cache
// survives re-renders.
function getQueryClient() {
	if (typeof window === "undefined") return new QueryClient();
	browserQueryClient ??= new QueryClient();
	return browserQueryClient;
}

export function Providers({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={getQueryClient()}>{children}</QueryClientProvider>;
}
