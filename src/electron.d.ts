declare module "electron" {
  export interface IpcMainInvokeEvent {
    sender: unknown;
  }

  export interface DesktopCapturerSource {
    id: string;
    name: string;
    display_id?: string;
  }

  export const desktopCapturer: {
    getSources(opts: {
      types: string[];
      thumbnailSize?: { width: number; height: number };
      fetchWindowIcons?: boolean;
    }): Promise<DesktopCapturerSource[]>;
  };

  export interface DisplayMediaRequestHandlerOpts {
    useSystemPicker?: boolean;
  }

  export interface DisplayMediaStreams {
    video?: DesktopCapturerSource;
    audio?: "loopback" | "loopbackWithMute";
    enableLocalEcho?: boolean;
  }

  export interface Session {
    setDisplayMediaRequestHandler(
      handler:
        | ((request: unknown, callback: (streams: DisplayMediaStreams) => void) => void)
        | null,
      opts?: DisplayMediaRequestHandlerOpts
    ): void;
  }

  export const session: { defaultSession: Session };
}
