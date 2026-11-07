import { ClipsCollection } from '@/components/clips/clips-collection';

export const metadata = { title: 'Avatars · Clips · Qorlla' };

export default function CreationAvatarsPage() {
  return <ClipsCollection title="Avatars" query={{ view: 'mine', source: 'AVATAR_GENERATION' }} empty={'No avatar clips yet. Choose "Create with avatars" from the + menu.'} />;
}
