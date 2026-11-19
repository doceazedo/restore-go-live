export class Logger {
  constructor(public name: string, public color = "#a6d189") {}

  private log(level: "log" | "info" | "warn" | "error" | "debug", args: any[]) {
    console[level](
      `%c RestoreGoLive %c ${this.name} `,
      "background:#5865f2;color:#fff;font-weight:bold",
      `background:${this.color};color:#000`,
      ...args,
    );
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

  debug(...args: any[]) {
    this.log("debug", args);
  }
}
