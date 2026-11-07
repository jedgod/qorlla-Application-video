// Shown by Next.js the instant a link is clicked, while the next page's code loads. Same shape as a page (title row + list), so
// nothing jumps when the real page replaces it.
export default function DashboardLoading() {
  return (
    <div className="flex h-full w-full animate-pulse select-none flex-col" aria-busy="true" aria-label="Loading">
      <div className="flex items-center justify-between border-b border-gray-100 pb-4">
        <div className="h-6 w-36 rounded-md bg-gray-200" />
        <div className="h-8 w-8 rounded-full bg-gray-200" />
      </div>
      <div className="mt-4 space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 py-2"><div className="h-12 w-20 rounded-lg bg-gray-200" /><div className="flex-1 space-y-2"><div className="h-3.5 w-1/3 rounded bg-gray-200" /><div className="h-3 w-1/4 rounded bg-gray-100" /></div></div>
        ))}
      </div>
    </div>
  );
}
