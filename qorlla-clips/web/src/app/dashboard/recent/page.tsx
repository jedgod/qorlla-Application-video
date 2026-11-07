import { ClipsCollection } from '@/components/clips/clips-collection';

export const metadata = { title: 'Recent · Clips · Qorlla' };

export default function RecentPage() {
  return <ClipsCollection title="Recent" query={{ view: 'recent' }} empty={'Nothing here yet. Clips you create or that are shared with you appear here.'} />;
}
