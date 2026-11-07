import { redirect } from 'next/navigation';

// The Clips app lives under /dashboard; the default page is My playlists.
export default function Home() {
  redirect('/dashboard/my-playlists');
}
