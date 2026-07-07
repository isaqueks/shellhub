import { useCallback, useRef, useState } from "react";
import { ArrowUpTrayIcon } from "@heroicons/react/24/outline";

interface UploadDropzoneProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  children: React.ReactNode;
}

export default function UploadDropzone({
  onFiles,
  disabled,
  children,
}: UploadDropzoneProps) {
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current += 1;
    if (dragCounter.current > 0) setDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Prevent default so the browser allows the drop.
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragging(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
    [disabled, onFiles],
  );

  return (
    <div
      className="relative h-full w-full"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      {dragging && !disabled && (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-primary bg-primary/[0.06]">
          <ArrowUpTrayIcon className="h-8 w-8 text-primary" />
          <span className="text-sm font-medium text-text-primary">
            Drop files to upload
          </span>
        </div>
      )}
    </div>
  );
}
