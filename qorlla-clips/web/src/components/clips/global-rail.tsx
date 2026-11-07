'use client';

import { Calendar, Home, Layers, Mail, MessageSquare, MoreHorizontal, Settings, Video } from 'lucide-react';
import { cn } from '@/lib/utils';

// The rest of Qorlla lives on the main site; set NEXT_PUBLIC_MAIN_URL when it is on another origin (default: same origin).
const MAIN = (process.env.NEXT_PUBLIC_MAIN_URL || '').replace(/\/+$/, '');

const ITEMS = [
  { label: 'Home', icon: Home, href: `${MAIN}/qorlla.html#home` },
  { label: 'Mail', icon: Mail, href: `${MAIN}/qorlla.html#mail` },
  { label: 'Whiteboards', icon: Layers, href: `${MAIN}/qorlla.html#whiteboards` },
  { label: 'Chat', icon: MessageSquare, href: `${MAIN}/qorlla.html#chat` },
  { label: 'Calendar', icon: Calendar, href: `${MAIN}/qorlla.html#calendar` },
] as const;

export function GlobalRail({ initial }: { initial: string }) {
  const item = 'flex h-12 w-14 flex-col items-center justify-center rounded-lg text-gray-500 hover:bg-gray-200/50';
  return (
    <aside className="flex w-[72px] shrink-0 flex-col items-center justify-between border-r border-gray-200/60 bg-[#eef0f5] py-4" aria-label="Qorlla apps">
      <nav className="flex w-full flex-col items-center gap-1.5">
        <a href={`${MAIN}/qorlla.html`} className="mb-3 select-none text-xl font-extrabold tracking-tight text-brand" aria-label="Qorlla home">Qorlla</a>
        {ITEMS.map(({ label, icon: Icon, href }) => (
          <a key={label} href={href} className={item}>
            <Icon className="h-5 w-5" aria-hidden="true" /><span className="mt-0.5 text-[9.5px] font-medium">{label}</span>
          </a>
        ))}
        <span aria-current="page" className={cn(item, 'relative border border-gray-200 bg-white text-brand shadow-sm')}>
          <Video className="h-5 w-5" aria-hidden="true" /><span className="mt-0.5 text-[9.5px] font-semibold">Clips</span>
          <span className="absolute right-1 top-1 rounded-full bg-primary px-1 text-[7.5px] font-bold uppercase text-white">New</span>
        </span>
        <a href={`${MAIN}/qorlla.html#more`} className={item}>
          <MoreHorizontal className="h-5 w-5" aria-hidden="true" /><span className="mt-0.5 text-[9.5px] font-medium">More</span>
        </a>
      </nav>
      <div className="flex flex-col items-center gap-3">
        <a href={`${MAIN}/qorlla.html#settings`} aria-label="Settings" className="text-gray-500 hover:text-gray-700"><Settings className="h-5 w-5" /></a>
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-600 text-xs font-bold text-white shadow-inner" aria-label="Your account">{initial}</div>
      </div>
    </aside>
  );
}
