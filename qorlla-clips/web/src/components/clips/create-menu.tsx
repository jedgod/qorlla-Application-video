'use client';

import { Lock, Plus, Sparkles, Upload } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { ClipSource } from '@/lib/api';

/** The blue "+" button: one menu item per way of creating a clip. Upload stays locked (and says why) on the free plan. */
export function CreateMenu({ uploadEnabled, onCreate }: { uploadEnabled: boolean; onCreate: (source: ClipSource) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Create a clip"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white shadow-sm transition-colors hover:bg-brand-dark focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          <Plus className="h-5 w-5" strokeWidth={2.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[220px]">
        <DropdownMenuItem onSelect={() => onCreate('RECORDING')}>
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-gray-400" aria-hidden="true"><span className="h-1.5 w-1.5 rounded-full bg-gray-900" /></span>
          <span>Record a clip</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCreate('AVATAR_GENERATION')}>
          <Sparkles className="h-3.5 w-3.5 fill-blue-500/10 text-blue-500" aria-hidden="true" />
          <span>Create with avatars</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCreate('SLIDE_CONVERSION')}>
          <Sparkles className="h-3.5 w-3.5 fill-blue-500/10 text-blue-500" aria-hidden="true" />
          <span>Create from slides</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!uploadEnabled}
          title={uploadEnabled ? undefined : 'Uploading video is available on paid plans'}
          onSelect={() => onCreate('UPLOAD')}
        >
          <Upload className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
          <span>Upload video</span>
          {!uploadEnabled ? <Lock className="ml-auto h-3 w-3 text-gray-400" aria-label="Locked" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
