declare global {
  var IS_DISCORD_DESKTOP: boolean;
  var IS_WEB: boolean;
  var VencordNative: {
    pluginHelpers: Record<string, Record<string, (...args: any[]) => Promise<any>>>;
  };
}

export {};
