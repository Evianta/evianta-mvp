export function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-label="Loading" role="status">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className="surface-card flex items-center gap-4 p-4" key={index}>
          <div className="skeleton h-9 w-9 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="skeleton h-3 w-1/3" />
            <div className="skeleton h-2.5 w-2/3" />
          </div>
          <div className="skeleton h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}
