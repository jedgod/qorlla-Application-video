import { ClipsCollection } from '@/components/clips/clips-collection';

export const metadata = { title: 'My clips · Clips · Qorlla' };

export default function MyClipsPage() {
  return <ClipsCollection title="My clips" query={{ view: 'mine' }} empty={'You have not created any clips yet. Use the + button to start.'} />;
}
