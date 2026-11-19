declare global {
  var IS_DISCORD_DESKTOP: boolean;
  var IS_WEB: boolean;
  var RestoreGoLiveNative:
    | {
        helpers: Record<string, (...args: any[]) => Promise<any>>;
        settings: {
          get(): Record<string, unknown>;
          set(values: Record<string, unknown>): Promise<void>;
          onChange(cb: (values: Record<string, unknown>) => void): void;
        };
      }
    | undefined;
}

export {};
