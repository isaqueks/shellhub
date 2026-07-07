import { HomeIcon, ChevronRightIcon } from "@heroicons/react/24/outline";

interface BreadcrumbProps {
  path: string;
  onNavigate: (path: string) => void;
}

export default function Breadcrumb({ path, onNavigate }: BreadcrumbProps) {
  const segments = path.split("/").filter(Boolean);
  const atRoot = segments.length === 0;

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 min-w-0 overflow-x-auto whitespace-nowrap text-xs"
    >
      {atRoot ? (
        <span
          aria-current="page"
          className="flex items-center text-text-primary shrink-0"
        >
          <HomeIcon className="w-3.5 h-3.5" strokeWidth={2} aria-hidden="true" />
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onNavigate("/")}
          aria-label="Root"
          className="flex items-center text-text-secondary hover:text-text-primary transition-colors shrink-0"
        >
          <HomeIcon className="w-3.5 h-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      )}

      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1;
        const cumulative = "/" + segments.slice(0, i + 1).join("/");

        return (
          <span key={cumulative} className="flex items-center gap-1 min-w-0">
            <ChevronRightIcon
              className="w-3 h-3 text-text-muted shrink-0"
              strokeWidth={2}
              aria-hidden="true"
            />
            {isLast ? (
              <span
                aria-current="page"
                title={segment}
                className="text-text-primary font-medium truncate"
              >
                {segment}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(cumulative)}
                title={segment}
                className="text-text-secondary hover:text-text-primary transition-colors truncate"
              >
                {segment}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
