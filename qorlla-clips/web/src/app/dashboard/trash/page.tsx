import { ClipsCollection } from '@/components/clips/clips-collection';

export const metadata = { title: 'Trash · Clips · Qorlla' };

export default function TrashPage() {
  return <ClipsCollection title="Trash" query={{ view: 'trash' }} empty={'Trash is empty. Clips you delete wait here until you remove them for good.'} trash />;
}
