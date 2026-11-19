import { OptionTypeValue } from "./plugin";

interface OptionDef {
  type: OptionTypeValue;
  description: string;
  default: any;
  [key: string]: any;
}

type Store<D extends Record<string, OptionDef>> = { [K in keyof D]: D[K]["default"] };

interface Backend {
  load(): Record<string, any>;
  save(values: Record<string, any>): void;
  onChange(cb: (values: Record<string, any>) => void): void;
}

const STORAGE_KEY = "RestoreGoLive:settings";

function desktopBackend(): Backend | null {
  const native = (globalThis as any).RestoreGoLiveNative;
  if (!native?.settings) return null;
  return {
    load: () => native.settings.get() ?? {},
    save: (values) => void native.settings.set(values),
    onChange: (cb) => native.settings.onChange(cb),
  };
}

function webBackend(): Backend {
  return {
    load() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      } catch {
        return {};
      }
    },
    save(values) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
      } catch {}
    },
    onChange(cb) {
      addEventListener("storage", (e) => {
        if (e.key === STORAGE_KEY) cb(this.load());
      });
    },
  };
}

export function definePluginSettings<D extends Record<string, OptionDef>>(def: D) {
  const defaults = Object.fromEntries(Object.entries(def).map(([k, v]) => [k, v.default]));
  const backend = desktopBackend() ?? webBackend();
  let values: Record<string, any> = { ...defaults, ...backend.load() };
  backend.onChange((next) => {
    values = { ...defaults, ...next };
  });

  const store = new Proxy({} as Store<D>, {
    get: (_, key) => values[key as string],
    set: (_, key, value) => {
      values = { ...values, [key as string]: value };
      backend.save(values);
      return true;
    },
    has: (_, key) => key in values,
    ownKeys: () => Reflect.ownKeys(values),
    getOwnPropertyDescriptor: (_, key) =>
      key in values
        ? { configurable: true, enumerable: true, writable: true, value: values[key as string] }
        : undefined,
  });

  return { def, store };
}
