import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "shared-memory",
  description: "A dead-simple Git-backed shared memory layer for AI agents.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
