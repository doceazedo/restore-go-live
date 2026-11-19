import electron, { app, BrowserWindowConstructorOptions, ipcMain, session, webContents } from "electron";
import EventEmitter from "events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

import * as native from "../src/native";

const PREFIX = "RestoreGoLive";
const SETTINGS = join(__dirname, "..", "settings.json");
const injector = require.main!.filename;
const asarPath = join(dirname(injector), "..", "_app.asar");

const LOG_DIR = join(__dirname, "..", "logs");

function trace(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] [${process.pid}] ${parts
    .map((p) => (p instanceof Error ? p.stack ?? p.message : typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")}`;
  console.log(`[${PREFIX}] ${line}`);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "main.log"), line + "\n");
  } catch {}
}

trace(`starting from ${__dirname}, exe ${process.execPath}, argv ${JSON.stringify(process.argv.slice(1))}`);

function signalLaunch() {
  try {
    const launch = { pid: process.pid, exe: process.execPath, at: Math.floor(Date.now() / 1000) };
    writeFileSync(join(__dirname, "..", "launched.json"), JSON.stringify(launch));
  } catch (e) {
    trace("could not signal launch", e);
  }
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(values: Record<string, unknown>) {
  writeFileSync(SETTINGS, JSON.stringify(values, null, 2));
}

function registerIpc() {
  const methods: string[] = [];
  for (const [name, fn] of Object.entries(native)) {
    if (typeof fn !== "function") continue;
    methods.push(name);
    ipcMain.handle(`${PREFIX}:${name}`, (event, ...args) => (fn as any)(event, ...args));
  }

  ipcMain.on(`${PREFIX}:methods`, (event) => {
    event.returnValue = methods;
  });
  ipcMain.on(`${PREFIX}:settings:get`, (event) => {
    event.returnValue = readSettings();
  });
  ipcMain.handle(`${PREFIX}:settings:set`, (_, values: Record<string, unknown>) => writeSettings(values));

  let timer: ReturnType<typeof setTimeout> | null = null;
  const broadcast = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const values = readSettings();
      for (const wc of webContents.getAllWebContents()) wc.send(`${PREFIX}:settings:changed`, values);
    }, 100);
  };
  try {
    if (!existsSync(SETTINGS)) writeSettings({});
    watch(SETTINGS, broadcast);
  } catch (e) {
    console.error(`[${PREFIX}] cannot watch settings`, e);
  }
}

function patchCsp(headers: Record<string, string[]>) {
  const find = (name: string) => Object.keys(headers).find((h) => h.toLowerCase() === name);
  const reportOnly = find("content-security-policy-report-only");
  if (reportOnly) delete headers[reportOnly];

  const header = find("content-security-policy");
  if (!header) return;

  const policy: Record<string, string[]> = {};
  for (const directive of headers[header][0].split(";")) {
    const [key, ...values] = directive.trim().split(/\s+/g);
    if (key && !(key in policy)) policy[key] = values;
  }
  const push = (key: string, ...values: string[]) => {
    policy[key] ??= [...(policy["default-src"] ?? [])];
    policy[key].push(...values);
  };
  push("script-src", "'unsafe-inline'", "'unsafe-eval'");
  for (const key of ["connect-src", "img-src", "media-src", "worker-src"]) push(key, "blob:", "data:");

  headers[header] = [
    Object.entries(policy)
      .filter(([, v]) => v.length)
      .map(([k, v]) => [k, ...v].join(" "))
      .join("; "),
  ];
}

function installCsp() {
  session.defaultSession.webRequest.onHeadersReceived(({ responseHeaders, resourceType }, cb) => {
    if (responseHeaders && resourceType === "mainFrame") patchCsp(responseHeaders);
    cb({ cancel: false, responseHeaders });
  });
}

function installBrowserWindowHook() {
  class BrowserWindow extends electron.BrowserWindow {
    constructor(options: BrowserWindowConstructorOptions) {
      if (!options?.webPreferences?.preload || !options.title) {
        super(options);
        return;
      }
      trace(`hooking window "${options.title}", original preload ${options.webPreferences.preload}`);
      process.env.DISCORD_PRELOAD = options.webPreferences.preload;
      options.webPreferences.preload = join(__dirname, "preload.js");
      options.webPreferences.sandbox = false;
      super(options);
    }
  }
  Object.assign(BrowserWindow, electron.BrowserWindow);
  Object.defineProperty(BrowserWindow, "name", { value: "BrowserWindow", configurable: true });

  const electronPath = require.resolve("electron");
  delete (require.cache[electronPath] as any).exports;
  (require.cache[electronPath] as any).exports = { ...electron, BrowserWindow };
}

function enableDevtools() {
  let value: any;
  Object.defineProperty(global, "appSettings", {
    configurable: true,
    enumerable: true,
    get: () => value,
    set(settings: any) {
      value = settings;
      try {
        settings?.set?.("DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING", true);
      } catch {}
    },
  });
}

function versionOf(dir: string) {
  return dir.slice("app-".length).split(".").map(Number);
}

function isNewer(next: string, current: string) {
  const a = versionOf(next);
  const b = versionOf(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function shimSource(mainJs: string) {
  return `const target = ${JSON.stringify(mainJs)};
if (require("fs").existsSync(target)) {
  require(target);
} else {
  const path = require("path");
  const message = "[" + new Date().toISOString() + "] [" + process.pid + "] payload missing at " + target + ", starting Discord without it";
  console.error("[RestoreGoLive] " + message);
  try {
    const logs = path.join(path.dirname(target), "..", "logs");
    require("fs").mkdirSync(logs, { recursive: true });
    require("fs").appendFileSync(path.join(logs, "main.log"), message + "\\n");
  } catch {}
  const original = path.join(__dirname, "..", "_app.asar");
  const pkg = require(path.join(original, "package.json"));
  require.main.filename = path.join(original, pkg.main);
  require("electron").app.setAppPath(original);
  require(require.main.filename);
}
`;
}

function repatchLatest() {
  try {
    const fs = require("original-fs") as typeof import("fs");
    const appDir = dirname(process.execPath);
    const current = basename(appDir);
    const root = dirname(appDir);
    const latest = fs
      .readdirSync(root)
      .filter((d) => d.startsWith("app-"))
      .reduce((best, d) => (isNewer(d, best) ? d : best), current);
    if (latest === current) return;

    const resources = join(root, latest, "resources");
    const asar = join(resources, "app.asar");
    const original = join(resources, "_app.asar");
    if (!fs.existsSync(asar) || fs.existsSync(original) || !fs.statSync(asar).isFile()) return;

    console.log(`[${PREFIX}] host update ${current} -> ${latest}, repatching`);
    fs.renameSync(asar, original);
    fs.mkdirSync(asar);
    fs.writeFileSync(join(asar, "index.js"), shimSource(join(__dirname, "main.js")));
    fs.writeFileSync(
      join(asar, "package.json"),
      JSON.stringify({ name: "discord", main: "index.js", restoreGoLive: true }),
    );
  } catch (e) {
    console.error(`[${PREFIX}] failed to repatch host update`, e);
  }
}

function installUpdatePersistence() {
  if (process.platform !== "win32") return;
  EventEmitter.prototype.emit = new Proxy(EventEmitter.prototype.emit, {
    apply(target, self, args) {
      if (args[0] === "host-updated") repatchLatest();
      return Reflect.apply(target, self, args);
    },
  });
  app.on("before-quit", repatchLatest);
}

function forwardRendererLogs() {
  if (process.env.RGL_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.RGL_DEBUG_PORT);
  if (!process.env.RGL_DEBUG) return;
  app.on("web-contents-created", (_, contents) => {
    contents.on("console-message", (...args: any[]) => {
      const message = typeof args[2] === "string" ? args[2] : args[0]?.message;
      if (typeof message === "string" && message.includes(PREFIX)) console.log(`[renderer] ${message.replace(/%c|\s?background:\S+/g, "")}`);
    });
  });
}

const discordPkg = require(join(asarPath, "package.json"));
require.main!.filename = join(asarPath, discordPkg.main);
(app as any).setAppPath(asarPath);

const steps: Array<[string, () => void]> = [
  ["ipc", registerIpc],
  ["renderer logs", forwardRendererLogs],
  ["browser window hook", installBrowserWindowHook],
  ["update persistence", installUpdatePersistence],
  ["devtools", enableDevtools],
];
for (const [name, step] of steps) {
  try {
    step();
  } catch (e) {
    trace(`step ${name} failed`, e);
  }
}
app.whenReady().then(installCsp, (e) => trace("csp failed", e));
app.whenReady().then(signalLaunch);

app.on("browser-window-created", (_, win) => {
  trace(`window created, preload ${win.webContents.session.getPreloads?.().length ?? "?"} session preloads`);
});

trace("loading original app.asar");
require(require.main!.filename);
