import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "BubblesEdiy Cinema AI", description: "Original film development and continuity studio" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
