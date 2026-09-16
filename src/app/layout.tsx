import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Trading OS · Private Workstation", description: "A private trading-process workstation. Written rules, deterministic risk and immutable history.", robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0b0e12" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
