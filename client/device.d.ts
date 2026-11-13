interface DeviceProfile {
  id: string;
  nick: string;
  code: string;
  dnd: boolean;
  role: "owner" | "member";
}
interface Window {
  privalDevice?: {
    profile: () => Promise<DeviceProfile | null>;
    create: (nick: string) => Promise<DeviceProfile>;
    erase: () => Promise<null>;
    hotkey: (key: string | null) => Promise<void>;
    overlaySettings?: (
      change?: OverlayPrefs,
    ) => Promise<OverlayPrefs & { displays: { id: string; name: string }[] }>;
    overlayState?: (state: {
      active: boolean;
      mic?: boolean;
      deaf?: boolean;
      status?: string;
      peers: { id: string; name: string; self: boolean; speaking: boolean }[];
    }) => void;
    onKey: (fn: (pressed: boolean) => void) => () => void;
  };
}
interface OverlayPrefs {
  enabled: boolean;
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  display: string;
}
