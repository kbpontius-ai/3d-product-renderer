export function LoadingSpinner({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`loading-spinner${compact ? ' loading-spinner-compact' : ''}`}
      aria-hidden="true"
    />
  );
}
