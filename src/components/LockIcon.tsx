// Inline padlock icon (no external dependency). `locked` shows a closed shackle;
// otherwise an open one. Inherits color via currentColor and sizes to the font.
export function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      {locked ? (
        // Closed shackle: both legs down into the body.
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      ) : (
        // Open shackle: swung to the side (right leg lifted).
        <path d="M8 11V7a4 4 0 0 1 8 0" />
      )}
    </svg>
  );
}
