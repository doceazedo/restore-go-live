declare module "electron" {
  export interface IpcMainInvokeEvent {
    sender: unknown;
  }

  export interface DisplayMediaRequestHandlerOpts {
    useSystemPicker?: boolean;
  }

  export interface Session {
    setDisplayMediaRequestHandler(
      handler: ((request: unknown, callback: (streams: {
        video?: unknown;
        audio?: unknown;
        enableLocalEcho?: boolean;
      }) => void) => void) | null,
      opts?: DisplayMediaRequestHandlerOpts
    ): void;
  }

  export const session: { defaultSession: Session };
}
