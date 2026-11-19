import { Logger } from "../logger";
import { cache, canonicalizeMatch, executed, moduleListeners, wreq } from "./patcher";

export type Filter = (m: any) => boolean;

const logger = new Logger("Finders", "#ef9f76");
const PROXY_CHECK = "is this a proxy that returns values for any key?";
const TypedArray = Object.getPrototypeOf(Int8Array);

function ignored(value: any) {
  if (value == null) return true;
  if (value === window || value === document || value === document.documentElement) return true;
  const tag = value[Symbol.toStringTag];
  if (tag === "DOMTokenList" || tag === "IntlMessagesProxy") return true;
  if (value[PROXY_CHECK] !== void 0) {
    Reflect.deleteProperty(value, PROXY_CHECK);
    return true;
  }
  return value instanceof TypedArray;
}

function codeOf(fn: Function) {
  try {
    return Function.prototype.toString.call(fn);
  } catch {
    return "";
  }
}

function codeMatches(source: string, code: Array<string | RegExp>) {
  return code.every((c) => (typeof c === "string" ? source.includes(c) : (c.lastIndex = 0, c.test(source))));
}

export const filters = {
  byProps:
    (...props: string[]): Filter =>
    (m) =>
      props.every((p) => m[p] !== void 0),
  byCode: (...code: Array<string | RegExp>): Filter => {
    const canon = code.map(canonicalizeMatch);
    return (m) => typeof m === "function" && codeMatches(codeOf(m), canon);
  },
  byStoreName:
    (name: string): Filter =>
    (m) =>
      m?.constructor?.displayName === name,
};

function test(filter: Filter, value: any) {
  try {
    return !ignored(value) && filter(value);
  } catch {
    return false;
  }
}

function search(filter: Filter, exports: any) {
  if (test(filter, exports)) return exports;
  if (typeof exports !== "object" || exports == null) return null;
  for (const key in exports) {
    let value: any;
    try {
      value = exports[key];
    } catch {
      continue;
    }
    if (test(filter, value)) return value;
  }
  return null;
}

function* modules() {
  yield* executed.values();
  if (!cache) return;
  for (const id in cache) {
    if (!executed.has(id)) yield cache[id];
  }
}

export function find(filter: Filter) {
  for (const mod of modules()) {
    if (mod == null || mod.exports == null) continue;
    const hit = search(filter, mod.exports);
    if (hit != null) return hit;
  }
  return null;
}

function findModuleId(...code: Array<string | RegExp>): string | null {
  if (!wreq?.m) return null;
  const canon = code.map(canonicalizeMatch);
  for (const id in wreq.m) {
    if (codeMatches(factoryCode(wreq.m[id]), canon)) return id;
  }
  return null;
}

function factoryCode(factory: any): string {
  try {
    return String(factory);
  } catch {
    return "";
  }
}

export function mapMangledModule<S extends string>(code: string | RegExp, mappers: Record<S, Filter>) {
  const result = {} as Record<S, any>;
  const id = findModuleId(code);
  if (id == null) return result;
  const mod = wreq(id);
  for (const key of Object.getOwnPropertyNames(mod)) {
    let member: any;
    try {
      member = mod[key];
    } catch {
      continue;
    }
    for (const name in mappers) {
      if (!(name in result) && test(mappers[name], member)) {
        result[name] = member;
        break;
      }
    }
  }
  return result;
}

function proxyLazy<T = any>(factory: () => T, describe: string): T {
  let resolved: any;
  const dummy = function () {} as any;
  const get = () => {
    if (resolved != null) return resolved;
    resolved = factory();
    if (resolved == null) throw new Error(`webpack module not found: ${describe}`);
    return resolved;
  };

  return new Proxy(dummy, {
    get: (_, key) => (key === "__rglLazy" ? describe : Reflect.get(get(), key)),
    set: (_, key, value) => Reflect.set(get(), key, value),
    has: (_, key) => Reflect.has(get(), key),
    apply: (_, self, args) => Reflect.apply(get(), self, args),
    construct: (_, args) => Reflect.construct(get(), args),
    deleteProperty: (_, key) => Reflect.deleteProperty(get(), key),
    getPrototypeOf: () => Reflect.getPrototypeOf(get()),
    ownKeys: () => {
      const keys = new Set(Reflect.ownKeys(get()));
      for (const key of Reflect.ownKeys(dummy)) {
        if (!Reflect.getOwnPropertyDescriptor(dummy, key)?.configurable) keys.add(key);
      }
      return [...keys];
    },
    getOwnPropertyDescriptor: (_, key) => {
      const own = Reflect.getOwnPropertyDescriptor(dummy, key);
      if (own && !own.configurable) return own;
      const desc = Reflect.getOwnPropertyDescriptor(get(), key);
      if (desc) desc.configurable = true;
      return desc;
    },
  });
}

export function findLazy<T = any>(filter: Filter, describe = "findLazy"): T {
  return proxyLazy(() => find(filter), describe);
}

export function findByPropsLazy<T = any>(...props: string[]): T {
  return proxyLazy(() => find(filters.byProps(...props)), `byProps(${props.join(", ")})`);
}

export function findByCodeLazy<T = any>(...code: Array<string | RegExp>): T {
  return proxyLazy(() => find(filters.byCode(...code)), `byCode(${code.join(", ")})`);
}

const fluxStores = new Map<string, any>();

function populateFluxStores() {
  try {
    const flux = find(filters.byProps("connectStores"));
    for (const store of flux?.Store?.getAll?.() ?? []) fluxStores.set(store.getName(), store);
  } catch (e) {
    logger.warn("could not list flux stores", e);
  }
  try {
    const libdiscore = find(filters.byCode("libdiscoreWasm is not initialized"))?.();
    for (const key in libdiscore ?? {}) {
      if (key.endsWith("Store")) fluxStores.set(key, libdiscore[key]);
    }
  } catch {}
}

export function findStore<T = any>(name: string): T {
  if (!fluxStores.has(name)) populateFluxStores();
  if (fluxStores.has(name)) return fluxStores.get(name);
  const found = find(filters.byStoreName(name));
  if (found != null) fluxStores.set(name, found);
  return found;
}

export function findStoreLazy<T = any>(name: string): T {
  return proxyLazy(() => findStore(name), `store(${name})`);
}

export function mapMangledModuleLazy<S extends string>(code: string | RegExp, mappers: Record<S, Filter>) {
  return proxyLazy(() => {
    const mapped = mapMangledModule(code, mappers);
    return Object.keys(mapped).length ? mapped : null;
  }, `mapMangled(${code})`) as Record<S, any>;
}

export function waitFor(filter: Filter | string[], callback: (value: any) => void) {
  const fn = Array.isArray(filter) ? filters.byProps(...filter) : filter;
  const existing = find(fn);
  if (existing != null) {
    callback(existing);
    return;
  }
  const listener = (exports: any) => {
    const hit = search(fn, exports);
    if (hit == null) return;
    moduleListeners.delete(listener);
    try {
      callback(hit);
    } catch (e) {
      logger.error("waitFor callback failed", e);
    }
  };
  moduleListeners.add(listener);
}
