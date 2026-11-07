import { ClipsCollection } from '@/components/clips/clips-collection';

export const metadata = { title: 'Shared with me · Clips · Qorlla' };

export default function SharedWithMePage() {
  return <ClipsCollection title="Shared with me" query={{ view: 'shared' }} empty={'No one has shared a clip with you yet.'} />;
}
