function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error || (value && typeof value === "object" && "name" in value && "message" in value)) {
    const err = value as Error;
    const head = `${err.name}: ${err.message}`;
    return err.stack?.includes(err.message) ? err.stack : `${head}${err.stack ? `\n${err.stack}` : ""}`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function persist(level: string, name: string, args: any[]) {
  try {
    const sink = (globalThis as any).RestoreGoLiveNative?.log;
    if (typeof sink !== "function") return;
    sink(`[${level}] [${name}] ${args.map(describe).join(" ")}`);
  } catch {}
}

export class Logger {
  constructor(public name: string, public color = "#a6d189") {}

  private log(level: "log" | "info" | "warn" | "error" | "debug", args: any[]) {
    console[level](
      `%c RestoreGoLive %c ${this.name} `,
      "background:#5865f2;color:#fff;font-weight:bold",
      `background:${this.color};color:#000`,
      ...args,
    );
    persist(level, this.name, args);
  }

  info(...args: any[]) {
    this.log("info", args);
  }

  warn(...args: any[]) {
    this.log("warn", args);
  }

  error(...args: any[]) {
    this.log("error", args);
  }
}
