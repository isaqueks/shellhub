import { create } from "zustand";
import { generateRandomUUID } from "@/utils/random-uuid";
import { useRecentDevicesStore } from "./recentDevicesStore";
import type { SftpConnectionStatus } from "@/components/sftp/sftpProtocol";

export type SftpWindowState = "docked" | "minimized" | "fullscreen";

export interface SftpSession {
  id: string;
  deviceUid: string;
  deviceName: string;
  username: string;
  password: string;
  fingerprint?: string;
  privateKey?: string;
  passphrase?: string;
  state: SftpWindowState;
  connectionStatus: SftpConnectionStatus;
}

export interface SftpReconnectTarget {
  deviceUid: string;
  deviceName: string;
}

interface SftpState {
  sessions: SftpSession[];
  /**
   * Device whose ConnectDrawer (SFTP variant) should open. Set by requestConnect and consumed by SftpManager, which
   * builds the sshid and opens the drawer.
   */
  reconnectTarget: SftpReconnectTarget | null;
  open: (
    params: Omit<SftpSession, "id" | "state" | "connectionStatus">,
  ) => void;
  minimize: (id: string) => void;
  minimizeAll: () => void;
  restore: (id: string) => void;
  toggleFullscreen: (id: string) => void;
  close: (id: string) => void;
  requestConnect: (deviceUid: string, deviceName: string) => void;
  clearReconnect: () => void;
  setConnectionStatus: (id: string, status: SftpConnectionStatus) => void;
  clearSensitiveData: (id: string) => void;
}

function demoteOthers(
  sessions: SftpSession[],
  targetId: string,
): SftpSession[] {
  return sessions.map((s) => {
    if (s.id === targetId) return s;
    if (s.state !== "minimized") return { ...s, state: "minimized" as const };
    return s;
  });
}

export const useSftpStore = create<SftpState>((set) => ({
  sessions: [],
  reconnectTarget: null,

  open: (params) => {
    const id = generateRandomUUID();
    useRecentDevicesStore.getState().record(params.deviceUid, params.deviceName);
    set((state) => ({
      reconnectTarget: null,
      sessions: [
        ...demoteOthers(state.sessions, id),
        { ...params, id, state: "docked", connectionStatus: "connecting" },
      ],
    }));
  },

  minimize: (id) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, state: "minimized" as const } : s,
      ),
    }));
  },

  minimizeAll: () => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.state !== "minimized" ? { ...s, state: "minimized" as const } : s,
      ),
    }));
  },

  restore: (id) => {
    set((state) => ({
      sessions: demoteOthers(state.sessions, id).map((s) =>
        s.id === id ? { ...s, state: "docked" as const } : s,
      ),
    }));
  },

  toggleFullscreen: (id) => {
    set((state) => ({
      sessions: demoteOthers(state.sessions, id).map((s) => {
        if (s.id !== id) return s;
        return {
          ...s,
          state:
            s.state === "fullscreen"
              ? ("docked" as const)
              : ("fullscreen" as const),
        };
      }),
    }));
  },

  close: (id) => {
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
    }));
  },

  requestConnect: (deviceUid, deviceName) => {
    set({ reconnectTarget: { deviceUid, deviceName } });
  },

  clearReconnect: () => {
    set({ reconnectTarget: null });
  },

  setConnectionStatus: (id, status) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, connectionStatus: status } : s,
      ),
    }));
  },

  clearSensitiveData: (id) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id
          ? { ...s, privateKey: undefined, passphrase: undefined, password: "" }
          : s,
      ),
    }));
  },
}));
