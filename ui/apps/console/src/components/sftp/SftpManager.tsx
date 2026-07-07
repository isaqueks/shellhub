import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useSftpStore } from "@/stores/sftpStore";
import { useNamespace } from "@/hooks/useNamespaces";
import { useAuthStore } from "@/stores/authStore";
import ConnectDrawer from "../ConnectDrawer";
import { buildSshid } from "@/utils/sshid";
import SftpInstance from "./SftpInstance";
import SftpTaskbar from "./SftpTaskbar";

export default function SftpManager({
  sidebarOffset,
}: {
  sidebarOffset: number;
}) {
  const sessions = useSftpStore((s) => s.sessions);
  const minimizeAll = useSftpStore((s) => s.minimizeAll);
  const reconnectTarget = useSftpStore((s) => s.reconnectTarget);
  const tenantId = useAuthStore((s) => s.tenant) ?? "";
  const { namespace: currentNamespace } = useNamespace(tenantId);

  const [connectTarget, setConnectTarget] = useState<{
    uid: string;
    name: string;
    sshid: string;
  } | null>(null);

  // Open the SFTP-variant ConnectDrawer when a connect is requested (works from any page).
  useEffect(() => {
    if (!reconnectTarget) return;
    useSftpStore.getState().clearReconnect();
    const nsName = currentNamespace?.name;
    const sshid = nsName
      ? buildSshid(nsName, reconnectTarget.deviceName)
      : reconnectTarget.deviceUid;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConnectTarget({
      uid: reconnectTarget.deviceUid,
      name: reconnectTarget.deviceName,
      sshid,
    });
  }, [reconnectTarget, currentNamespace]);

  // Auto-minimize file browsers when navigating to another page.
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);
  useEffect(() => {
    if (location.pathname !== prevPathRef.current) {
      prevPathRef.current = location.pathname;
      minimizeAll();
    }
  }, [location.pathname, minimizeAll]);

  return (
    <>
      {connectTarget && (
        <ConnectDrawer
          open
          variant="sftp"
          onClose={() => setConnectTarget(null)}
          deviceUid={connectTarget.uid}
          deviceName={connectTarget.name}
          sshid={connectTarget.sshid}
        />
      )}

      {sessions.map((s) => {
        const isVisible = s.state !== "minimized";
        const isFullscreen = s.state === "fullscreen";

        return (
          <div
            key={s.id}
            style={{ left: isFullscreen ? 0 : sidebarOffset }}
            className={[
              "fixed top-14 bottom-0 right-0 z-40 flex flex-col bg-background",
              "transition-[opacity,transform,left] duration-200 ease-out",
              isVisible
                ? "opacity-100 translate-y-0"
                : "opacity-0 translate-y-3 pointer-events-none",
            ].join(" ")}
          >
            <SftpInstance session={s} visible={isVisible} />
          </div>
        );
      })}

      <SftpTaskbar sidebarOffset={sidebarOffset} />
    </>
  );
}
