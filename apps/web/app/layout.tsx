import type { Metadata } from 'next';
import './globals.css';
import { product } from '../components/product';
export const metadata: Metadata = {
  title: product.name,
  description: product.description,
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
