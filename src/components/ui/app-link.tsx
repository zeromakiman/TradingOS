import NextLink from "next/link";
import type { ComponentProps } from "react";
import { prefetchFor } from "./links";

/** Authenticated screens can fan out into many expensive reads; fetch destinations on navigation. */
export default function AppLink({ href, prefetch = false, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink href={href} prefetch={prefetchFor(href, prefetch)} {...props} />;
}
