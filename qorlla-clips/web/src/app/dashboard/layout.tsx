import { ClipsShell } from '@/components/clips/clips-shell';

// Server layout: the shell (rail, Clips navigation, recorder, upload queue) is a client component that stays mounted while the
// router swaps only {children}. Active-link highlighting happens inside it with usePathname().
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <ClipsShell>{children}</ClipsShell>;
}
