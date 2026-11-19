export type ReplaceFn = (match: string, ...groups: any[]) => string;

export interface PatchReplacement {
  match: string | RegExp;
  replace: string | ReplaceFn;
  noWarn?: boolean;
}

export interface Patch {
  plugin?: string;
  find: string | RegExp;
  replacement: PatchReplacement | PatchReplacement[];
  all?: boolean;
  noWarn?: boolean;
}

export const OptionType = {
  STRING: 0,
  NUMBER: 1,
  BIGINT: 2,
  BOOLEAN: 3,
  SELECT: 4,
  SLIDER: 5,
} as const;

export type OptionTypeValue = (typeof OptionType)[keyof typeof OptionType];

export interface PluginAuthor {
  name: string;
  id: bigint;
}

export interface PluginDef {
  name: string;
  description: string;
  tags?: string[];
  authors?: PluginAuthor[];
  required?: boolean;
  enabledByDefault?: boolean;
  settings?: { store: Record<string, any> };
  patches?: Omit<Patch, "plugin">[];
  start?(): void | Promise<void>;
  stop?(): void;
  [key: string]: any;
}

export default function definePlugin<P extends PluginDef>(plugin: P & ThisType<P>): P {
  return plugin;
}

export type PluginNative<T extends Record<string, any>> = {
  [K in keyof T as T[K] extends (event: any, ...args: any[]) => any ? K : never]: T[K] extends (
    event: any,
    ...args: infer A
  ) => infer R
    ? (...args: A) => R extends Promise<any> ? R : Promise<R>
    : never;
};
