import { Link } from "react-router-dom";
import {
  ExclamationTriangleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { Button, IconButton } from "@shellhub/design-system/primitives";
import type { TerminalError } from "@/components/terminal/terminalErrors";

interface SftpErrorBannerProps {
  error: TerminalError;
  onReconnect?: () => void;
  onClose: () => void;
}

export default function SftpErrorBanner({
  error,
  onReconnect,
  onClose,
}: SftpErrorBannerProps) {
  const showReconnect = error.reconnect && Boolean(onReconnect);

  return (
    <div
      role="alert"
      className="absolute inset-0 z-10 grid place-items-center bg-background/70 backdrop-blur-sm p-6 animate-slide-down"
    >
      <div className="relative w-full max-w-md bg-card border border-accent-red/20 rounded-lg shadow-lg px-5 py-4 flex items-start gap-3">
        <ExclamationTriangleIcon
          className="w-5 h-5 text-accent-red shrink-0 mt-0.5"
          strokeWidth={1.5}
        />
        <div className="flex-1 min-w-0">
          <div className="mb-1">
            <span className="block text-sm font-semibold text-text-primary">
              {error.title}
            </span>
            <span className="block text-sm text-text-muted">
              {error.message}
            </span>
          </div>
          {error.hints.length > 0 && (
            <p className="text-sm text-text-secondary leading-relaxed mb-2">
              {error.hints.join(" ")}
            </p>
          )}
          {error.links.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 mb-3">
              {error.links.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className="text-sm text-primary hover:text-primary-600 font-medium transition-colors"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            {showReconnect && (
              <Button size="sm" variant="success" onClick={onReconnect}>
                Reconnect
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
        <IconButton size="sm" aria-label="Dismiss" onClick={onClose}>
          <XMarkIcon className="w-3.5 h-3.5" />
        </IconButton>
      </div>
    </div>
  );
}
