'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, Bell, Building2, ShieldAlert, Clock, Folder, ListVideo, type LucideIcon, Share2, Sparkles, Star, Trash2, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Summary } from '@/lib/api';
import { useClips } from './clips-provider';

interface NavItem { label: string; href: string; icon: LucideIcon; count?: (s: Summary) => number; soon?: boolean }

export const CLIPS_NAV: NavItem[] = [
  { label: 'Notifications', href: '/dashboard/notifications', icon: Bell, count: (s) => s.unreadNotifications },
  { label: 'Recent', href: '/dashboard/recent', icon: Clock },
  { label: 'My clips', href: '/dashboard/my-clips', icon: User, count: (s) => s.myClipsCount },
  { label: 'My playlists', href: '/dashboard/my-playlists', icon: ListVideo, count: (s) => s.playlists.length },
  { label: 'Shared with me', href: '/dashboard/shared-with-me', icon: Share2, count: (s) => s.sharedCount },
  { label: 'Starred', href: '/dashboard/starred', icon: Star, count: (s) => s.starredCount },
  { label: 'Organization playlists', href: '/dashboard/organization', icon: Building2, count: (s) => s.organizationPlaylists.length },
  { label: 'Trash', href: '/dashboard/trash', icon: Trash2, count: (s) => s.trashCount },
];
export const CREATION_NAV: NavItem[] = [
  { label: 'Avatars', href: '/dashboard/creation/avatars', icon: Sparkles },
  { label: 'Projects', href: '/dashboard/creation/projects', icon: Folder, soon: true },
];

/** The link whose page (or a page nested under it, like a playlist) is showing. */
const INSIGHTS_NAV: NavItem[] = [{ label: 'Analytics', href: '/dashboard/analytics', icon: BarChart3 }];
const ADMIN_NAV: NavItem = { label: 'Moderation', href: '/dashboard/admin', icon: ShieldAlert };

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + '/');

function NavLink({ item, pathname, summary }: { item: NavItem; pathname: string; summary: Summary | null }) {
  const Icon = item.icon;
  const active = isActive(pathname, item.href);
  const n = summary && item.count ? item.count(summary) : 0;
  const unread = item.href.endsWith('/notifications');
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      data-nav={item.href.split('/').slice(2).join('/')}
      className={cn('flex w-full select-none items-center gap-3 rounded-lg px-3 py-1.5 text-[13.5px] font-medium transition-all duration-150', active ? 'bg-[#f0f4ff] text-brand' : 'text-gray-600 hover:bg-gray-50 active:bg-gray-100')}
    >
      <Icon className={cn('h-[17px] w-[17px] shrink-0 transition-colors', active ? 'text-brand' : item.label === 'Avatars' ? 'fill-blue-500/10 text-blue-500' : 'text-gray-400')} aria-hidden="true" />
      <span className="flex-1 truncate">{item.label}</span>
      {item.soon ? <span className="rounded bg-gray-100 px-1.5 text-[10px] font-semibold text-gray-500">Soon</span> : null}
      {n ? <span className={cn('min-w-5 rounded-full px-1.5 text-center text-[11px]', unread ? 'bg-red-500 font-semibold text-white' : 'text-gray-400')} aria-label={`${n}`}>{n}</span> : null}
    </Link>
  );
}

export function ClipsNav() {
  const pathname = usePathname();
  const { summary } = useClips();
  return (
    <>
      <nav className="space-y-[2px]" aria-label="Clips navigation">
        {CLIPS_NAV.map((item) => <NavLink key={item.href} item={item} pathname={pathname} summary={summary} />)}
      </nav>
      <div className="mx-1 my-4 h-px bg-gray-200/70" role="separator" />
      <span className="mb-1.5 block px-3 text-[10.5px] font-bold uppercase tracking-wider text-gray-400">Creation</span>
      <nav className="space-y-[2px]" aria-label="Creation pipeline">
        {CREATION_NAV.map((item) => <NavLink key={item.href} item={item} pathname={pathname} summary={summary} />)}
      </nav>
      <div className="mx-1 my-4 h-px bg-gray-200/70" role="separator" />
      <span className="mb-1.5 block px-3 text-[10.5px] font-bold uppercase tracking-wider text-gray-400">Insights</span>
      <nav className="space-y-[2px]" aria-label="Insights">
        {(summary?.role === 'ADMIN' ? [...INSIGHTS_NAV, ADMIN_NAV] : INSIGHTS_NAV).map((item) => <NavLink key={item.href} item={item} pathname={pathname} summary={summary} />)}
      </nav>
    </>
  );
}
