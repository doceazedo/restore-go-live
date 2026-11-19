import { React } from "./webpack/common";

export function __rglCreateElement(...args: any[]) {
  return React.createElement(...args);
}

export const __rglFragment = Symbol.for("react.fragment");
