import { Logger } from "./logger";
import { React } from "./webpack/common";

const logger = new Logger("ErrorBoundary", "#e78284");

interface Options {
  noop?: boolean;
}

let Boundary: any = null;

function boundary() {
  return (Boundary ??= class extends React.Component<{ noop?: boolean; children?: any }, { error: unknown }> {
    state = { error: null as unknown };

    static getDerivedStateFromError(error: unknown) {
      return { error };
    }

    componentDidCatch(error: unknown) {
      logger.error("component crashed", error);
    }

    render() {
      if (this.state.error == null) return this.props.children;
      if (this.props.noop) return null;
      return React.createElement(
        "div",
        { style: { color: "var(--text-danger, #f23f43)", padding: 8 } },
        "RestoreGoLive: this part crashed, check the console",
      );
    }
  });
}

function wrap<P extends object>(Component: (props: P) => any, options: Options = {}) {
  return (props: P) => React.createElement(boundary(), { noop: options.noop }, React.createElement(Component, props));
}

export default { wrap };
