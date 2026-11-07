import { ClipsCollection } from '@/components/clips/clips-collection';

export const metadata = { title: 'Starred · Clips · Qorlla' };

export default function StarredPage() {
  return <ClipsCollection title="Starred" query={{ view: 'starred' }} empty={'Star a clip to find it here quickly.'} />;
}
