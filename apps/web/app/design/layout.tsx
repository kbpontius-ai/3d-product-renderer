import { AppNav } from '@/components/app-nav';

export default function DesignLayout({ children }: { children: React.ReactNode }) {
  return <div className="editor-shell"><AppNav allowGuest />{children}</div>;
}
