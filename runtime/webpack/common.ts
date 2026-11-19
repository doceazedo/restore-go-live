import { filters, find, findLazy, findStoreLazy, mapMangledModule, mapMangledModuleLazy, waitFor } from "./finders";

export let React: any;
export let FluxDispatcher: any;

let resolveReady!: () => void;
export const onceReady = new Promise<void>((r) => (resolveReady = r));

waitFor(["createElement", "useEffect"], (m) => {
  React = m;
});

waitFor(["dispatch", "subscribe"], (m) => {
  FluxDispatcher = m;
  const cb = () => {
    m.unsubscribe("CONNECTION_OPEN", cb);
    resolveReady();
  };
  m.subscribe("CONNECTION_OPEN", cb);
});

export function useEffect(...args: any[]) {
  return React.useEffect(...args);
}

export function useReducer(...args: any[]) {
  return React.useReducer(...args);
}


export const RestAPI: any = findLazy((m) => typeof m === "object" && m.del && m.put && m.patch, "RestAPI");

export const Constants: any = mapMangledModuleLazy('ME:"/users/@me"', {
  Endpoints: filters.byProps("USER", "ME"),
});

export const UserStore: any = findStoreLazy("UserStore");
export const ChannelStore: any = findStoreLazy("ChannelStore");
export const SelectedChannelStore: any = findStoreLazy("SelectedChannelStore");
export const LocaleStore: any = findStoreLazy("LocaleStore");

const VARIANTS: Record<string, string> = {
  message: "primary",
  success: "success",
  failure: "critical",
  custom: "primary",
};

interface ToastData {
  message: string;
  type: string;
  id: string;
  options?: any;
}

let toaster: { kind: "modern" | "legacy"; show: (data: any) => void } | null = null;

function resolveToaster() {
  if (toaster) return toaster;
  const modern = find(filters.byCode(".currentToastMap.get(", "setState"));
  if (modern) return (toaster = { kind: "modern", show: modern });
  const legacy = mapMangledModule(".currentToastMap.has(", { show: filters.byCode(".currentToastMap.has(") });
  if (legacy.show) return (toaster = { kind: "legacy", show: legacy.show });
  return null;
}

export const Toasts = {
  Type: {
    MESSAGE: "message",
    SUCCESS: "success",
    FAILURE: "failure",
    CUSTOM: "custom",
  },
  genId: () => (Math.random() || Math.random()).toString(36).slice(2),
  show(data: ToastData) {
    const t = resolveToaster();
    if (!t) {
      console.warn("[RestoreGoLive] toast:", data.message);
      return;
    }
    if (t.kind === "modern") t.show({ text: data.message, variant: VARIANTS[data.type] ?? "primary" });
    else t.show(data);
  },
};
