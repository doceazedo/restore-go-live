import { Logger } from "../logger";
import { Patch, PatchReplacement } from "../plugin";

type Factory = ((this: any, module: any, exports: any, require: any) => any) & Record<PropertyKey, any>;
type Listener = (exports: any, id: PropertyKey) => void;

const logger = new Logger("Webpack", "#8caaee");
const WRAPPED = Symbol("RestoreGoLive.wrapped");
const IDENTIFIER = String.raw`(?:[A-Za-z_$][\w$]*)`;
const IGNORED_BUNDLES = ["sentry", "libdiscore", "fast-connect"];

export let wreq: any = null;
export let cache: Record<PropertyKey, any> | null = null;

const pending: Patch[] = [];
export const patchReport = new Map<Patch, { found: boolean; applied: number; errors: string[] }>();
export const moduleListeners = new Set<Listener>();
const readyListeners = new Set<() => void>();

export function onWebpackInit(cb: () => void) {
  if (wreq) cb();
  else readyListeners.add(cb);
}

function initWebpack(require: any) {
  if (wreq) return;
  wreq = require;
  cache = require.c;
  logger.info("webpack require captured");
  for (const cb of readyListeners) {
    try {
      cb();
    } catch (e) {
      logger.error("init listener failed", e);
    }
  }
  readyListeners.clear();
}

export function canonicalizeMatch<T extends string | RegExp>(match: T): T {
  if (typeof match === "string") return match;
  const source = match.source.replaceAll(/(\\*)\\i/g, (m, escapes: string) =>
    escapes.length % 2 === 0 ? `${escapes}${IDENTIFIER}` : m.slice(1),
  );
  return new RegExp(source, match.flags) as T;
}

function canonicalizeReplace(replace: PatchReplacement["replace"], self: string) {
  if (typeof replace === "function")
    return (...args: any[]) => (replace as any)(...args).replaceAll("$self", self);
  return replace.replaceAll("$self", self);
}

export function addPatches(patches: Patch[], self: string) {
  for (const patch of patches) {
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    const canon: Patch = {
      ...patch,
      find: canonicalizeMatch(patch.find),
      replacement: replacements.map((r) => ({
        ...r,
        match: canonicalizeMatch(r.match),
        replace: canonicalizeReplace(r.replace, self) as any,
      })),
    };
    pending.push(canon);
    patchReport.set(canon, { found: false, applied: 0, errors: [] });
  }
}

function matchesFind(code: string, find: Patch["find"]) {
  if (typeof find === "string") return code.includes(find);
  find.lastIndex = 0;
  return find.test(code);
}

function patchFactory(id: PropertyKey, original: Factory): Factory {
  const originalCode = Function.prototype.toString.call(original);
  const isArrow = originalCode.startsWith("(");
  let code = "0," + (isArrow ? "" : "function") + originalCode.slice(originalCode.indexOf("("));
  let factory: Factory = original;

  for (let i = 0; i < pending.length; i++) {
    const patch = pending[i];
    if (!matchesFind(originalCode, patch.find)) continue;

    const report = patchReport.get(patch)!;
    report.found = true;

    for (const replacement of patch.replacement as PatchReplacement[]) {
      const match = replacement.match;
      if (match instanceof RegExp) match.lastIndex = 0;
      let next = "";
      try {
        next = code.replace(match, replacement.replace as any);
        if (next === code) {
          if (!(patch.noWarn || replacement.noWarn))
            logger.warn(`patch had no effect (module ${String(id)}): ${match}`);
          continue;
        }
        const built = (0, eval)(`${next}\n//# sourceURL=RestoreGoLive/WebpackModule${String(id)}`);
        code = next;
        factory = built;
        report.applied++;
      } catch (e) {
        report.errors.push(String(e));
        logger.error(`patch errored (module ${String(id)}): ${match}`, e);
      }
    }

    if (!patch.all) pending.splice(i--, 1);
  }

  return factory;
}

function notify(exports: any, id: PropertyKey) {
  if (exports == null) return;
  for (const listener of moduleListeners) {
    try {
      listener(exports, id);
    } catch (e) {
      logger.error("module listener failed", e);
    }
  }
}

function wrapFactory(original: Factory, id: PropertyKey): Factory {
  if (typeof original !== "function" || original[WRAPPED]) return original;

  let patched: Factory | null = null;
  const wrapped = function (this: any, module: any, exports: any, require: any) {
    if (!wreq && typeof require === "function" && require.m != null && require.c != null) initWebpack(require);
    patched ??= patchFactory(id, original);

    let result: unknown;
    try {
      result = patched.call(this, module, exports, require);
    } catch (e) {
      if (patched === original) throw e;
      logger.error(`patched module ${String(id)} threw, falling back to the original`, e);
      result = original.call(this, module, exports, require);
    }

    notify(module.exports, module.id ?? id);
    return result;
  } as Factory;

  wrapped[WRAPPED] = true;
  wrapped.toString = () => Function.prototype.toString.call(original);
  return wrapped;
}

function instrument(instance: any, modules: Record<PropertyKey, Factory>) {
  for (const id in modules) modules[id] = wrapFactory(modules[id], id);

  const proxy = new Proxy(modules, {
    set(target, id, factory, receiver) {
      return Reflect.set(target, id, wrapFactory(factory, id), receiver);
    },
  });

  Object.defineProperty(instance, "m", {
    value: proxy,
    configurable: true,
    enumerable: true,
    writable: true,
  });

  Object.defineProperty(instance, "p", {
    configurable: true,
    enumerable: false,
    set(this: any, path: string) {
      Object.defineProperty(this, "p", { value: path, configurable: true, enumerable: true, writable: true });
      if (path === "/assets/" && this.c != null) initWebpack(this);
    },
  });
}

export function installWebpackHook() {
  Object.defineProperty(Function.prototype, "m", {
    configurable: true,
    enumerable: false,
    set(this: any, modules: Record<PropertyKey, Factory>) {
      Object.defineProperty(this, "m", { value: modules, configurable: true, enumerable: true, writable: true });

      const { stack } = new Error();
      if (!stack?.includes("http") || /at \d+? \(/.test(stack)) return;
      if (!String(this).includes("exports:{}")) return;

      const file = stack.match(/\/assets\/(.+?\.js)/)?.[1]?.toLowerCase();
      if (file && IGNORED_BUNDLES.some((name) => file.includes(name))) return;

      logger.info(`found webpack instance${file ? ` in ${file}` : ""}`);
      instrument(this, modules);
    },
  });
}
