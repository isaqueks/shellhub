import {
  ArrowUpTrayIcon,
  ArrowDownTrayIcon,
  CheckCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { Card, IconButton } from "@shellhub/design-system/primitives";
import { type SftpTransfer, formatSize } from "@/components/sftp/sftpProtocol";

interface TransferListProps {
  transfers: SftpTransfer[];
  onDismiss: (id: string) => void;
}

// Compact stack of in-flight and finished SFTP transfers. Each row shows a
// direction icon, the (truncated) name, and a status-dependent detail: a thin
// progress bar for active transfers, a green "Done", or the error message.
export default function TransferList({
  transfers,
  onDismiss,
}: TransferListProps) {
  if (transfers.length === 0) return null;

  return (
    <Card className="flex flex-col divide-y divide-border-light p-0 overflow-hidden">
      {transfers.map((t) => {
        const DirectionIcon =
          t.direction === "upload" ? ArrowUpTrayIcon : ArrowDownTrayIcon;
        // Guard total === 0: treat as indeterminate/full so the bar never NaNs.
        const pct =
          t.total > 0
            ? Math.min(100, Math.round((t.transferred / t.total) * 100))
            : 100;

        return (
          <div
            key={t.id}
            className="flex items-center gap-2 px-3 py-2 min-w-0"
          >
            <DirectionIcon
              className="w-3.5 h-3.5 shrink-0 text-text-muted"
              strokeWidth={1.5}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-xs font-medium text-text-primary truncate"
                  title={t.name}
                >
                  {t.name}
                </span>
                {t.status === "active" && (
                  <span className="text-2xs text-text-muted shrink-0 tabular-nums">
                    {formatSize(t.transferred)} / {formatSize(t.total)}
                  </span>
                )}
              </div>

              {t.status === "active" && (
                <div className="mt-1 h-1 rounded-full bg-border overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}

              {t.status === "done" && (
                <div className="mt-0.5 flex items-center gap-1 text-2xs text-accent-green">
                  <CheckCircleIcon className="w-3 h-3 shrink-0" strokeWidth={1.5} />
                  <span>Done</span>
                </div>
              )}

              {t.status === "error" && (
                <p
                  className="mt-0.5 text-2xs text-accent-red truncate"
                  title={t.error}
                >
                  {t.error ?? "Transfer failed"}
                </p>
              )}
            </div>

            <IconButton
              size="sm"
              aria-label={t.status === "active" ? "Cancel" : "Dismiss"}
              title={t.status === "active" ? "Cancel" : "Dismiss"}
              onClick={() => onDismiss(t.id)}
            >
              <XMarkIcon className="w-3.5 h-3.5" strokeWidth={2} />
            </IconButton>
          </div>
        );
      })}
    </Card>
  );
}
