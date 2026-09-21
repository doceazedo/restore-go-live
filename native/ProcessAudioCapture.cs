using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class Interop
{
    public const string ProcessLoopbackDevice = "VAD\\Process_Loopback";
    public const int VT_BLOB = 65;
    public const int ShareModeShared = 0;
    public const int StreamFlagsLoopback = 0x00020000;
    public const int StreamFlagsEventCallback = 0x00040000;
    public const uint BufferFlagsSilent = 0x2;

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct WaveFormat
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ActivationParams
    {
        public int ActivationType;
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    public struct PropVariantBlob
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public int cbSize;
        [FieldOffset(16)] public IntPtr pBlobData;
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig]
        int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject
    {
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, ref WaveFormat format, ref Guid audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint numBufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint numPaddingFrames);
        [PreserveSig] int IsFormatSupported(int shareMode, ref WaveFormat format, IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    public static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation operation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, IntPtr name);
}

internal sealed class ActivationHandler : Interop.IActivateAudioInterfaceCompletionHandler, Interop.IAgileObject
{
    public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);

    public void ActivateCompleted(Interop.IActivateAudioInterfaceAsyncOperation operation)
    {
        Done.Set();
    }
}

internal static class Program
{
    const int SampleRate = 48000;
    const int Channels = 2;
    const int BitsPerSample = 16;

    static Interop.WaveFormat Format()
    {
        var format = new Interop.WaveFormat();
        format.wFormatTag = 1;
        format.nChannels = Channels;
        format.nSamplesPerSec = SampleRate;
        format.wBitsPerSample = BitsPerSample;
        format.nBlockAlign = (ushort)(Channels * BitsPerSample / 8);
        format.nAvgBytesPerSec = (uint)(SampleRate * format.nBlockAlign);
        format.cbSize = 0;
        return format;
    }

    static Interop.IAudioClient Activate(uint pid, bool includeTree)
    {
        var activation = new Interop.ActivationParams();
        activation.ActivationType = 1;
        activation.TargetProcessId = pid;
        activation.ProcessLoopbackMode = includeTree ? 0 : 1;

        IntPtr blob = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Interop.ActivationParams)));
        IntPtr variant = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Interop.PropVariantBlob)));
        try
        {
            Marshal.StructureToPtr(activation, blob, false);

            var pv = new Interop.PropVariantBlob();
            pv.vt = Interop.VT_BLOB;
            pv.cbSize = Marshal.SizeOf(typeof(Interop.ActivationParams));
            pv.pBlobData = blob;
            Marshal.StructureToPtr(pv, variant, false);

            var iid = typeof(Interop.IAudioClient).GUID;
            var handler = new ActivationHandler();
            Interop.IActivateAudioInterfaceAsyncOperation operation;
            Interop.ActivateAudioInterfaceAsync(Interop.ProcessLoopbackDevice, ref iid, variant, handler, out operation);

            if (!handler.Done.Wait(5000)) throw new Exception("activation timed out");

            int hr;
            object activated;
            int result = operation.GetActivateResult(out hr, out activated);
            if (result < 0) throw new Exception("GetActivateResult failed with hresult 0x" + result.ToString("x8"));
            if (hr < 0) throw new Exception("activation failed with hresult 0x" + hr.ToString("x8"));
            return (Interop.IAudioClient)activated;
        }
        finally
        {
            Marshal.FreeHGlobal(variant);
            Marshal.FreeHGlobal(blob);
        }
    }

    static void Check(int hr, string what)
    {
        if (hr < 0) throw new Exception(what + " failed with hresult 0x" + hr.ToString("x8"));
    }

    static void WatchStdin(CancellationTokenSource cancel)
    {
        var thread = new Thread(delegate ()
        {
            try
            {
                var stdin = Console.OpenStandardInput();
                var buffer = new byte[64];
                while (stdin.Read(buffer, 0, buffer.Length) > 0) { }
            }
            catch { }
            cancel.Cancel();
        });
        thread.IsBackground = true;
        thread.Start();
    }

    [MTAThread]
    static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("usage: ProcessAudioCapture <pid> [--exclude] [--seconds N] [--watch-stdin]");
            return 2;
        }

        uint pid;
        if (!uint.TryParse(args[0], out pid))
        {
            Console.Error.WriteLine("error: pid must be a number");
            return 2;
        }

        bool exclude = Array.IndexOf(args, "--exclude") >= 0;
        int seconds = 0;
        int at = Array.IndexOf(args, "--seconds");
        if (at >= 0 && at + 1 < args.Length) int.TryParse(args[at + 1], out seconds);

        var cancel = new CancellationTokenSource();
        if (Array.IndexOf(args, "--watch-stdin") >= 0) WatchStdin(cancel);
        if (seconds > 0) cancel.CancelAfter(seconds * 1000);

        Interop.IAudioClient client = null;
        try
        {
            client = Activate(pid, !exclude);

            var format = Format();
            var session = Guid.Empty;
            Check(client.Initialize(
                Interop.ShareModeShared,
                Interop.StreamFlagsLoopback | Interop.StreamFlagsEventCallback,
                2000000,
                0,
                ref format,
                ref session), "Initialize");

            IntPtr handle = Interop.CreateEventW(IntPtr.Zero, false, false, IntPtr.Zero);
            if (handle == IntPtr.Zero) throw new Exception("could not create the capture event");
            Check(client.SetEventHandle(handle), "SetEventHandle");

            var captureIid = typeof(Interop.IAudioCaptureClient).GUID;
            object service;
            Check(client.GetService(ref captureIid, out service), "GetService");
            var capture = (Interop.IAudioCaptureClient)service;

            Check(client.Start(), "Start");
            Console.Error.WriteLine("capturing pid " + pid + " at " + SampleRate + "hz " + Channels + "ch s16le");

            var wait = new ManualResetEvent(false);
            wait.SafeWaitHandle = new SafeWaitHandle(handle, true);

            var stdout = Console.OpenStandardOutput();
            int blockAlign = format.nBlockAlign;
            var silence = new byte[0];
            long written = 0;
            long signals = 0;
            long timeouts = 0;
            long packets = 0;
            var report = DateTime.UtcNow;

            while (!cancel.IsCancellationRequested)
            {
                bool signalled = wait.WaitOne(200);
                if (signalled) signals++; else timeouts++;

                if (Environment.GetEnvironmentVariable("P2P_AUDIO_DEBUG") == "1"
                    && (DateTime.UtcNow - report).TotalSeconds >= 1)
                {
                    report = DateTime.UtcNow;
                    Console.Error.WriteLine("signals=" + signals + " timeouts=" + timeouts + " packets=" + packets + " bytes=" + written);
                }

                if (!signalled) continue;

                while (true)
                {
                    uint next;
                    Check(capture.GetNextPacketSize(out next), "GetNextPacketSize");
                    if (next == 0) break;
                    packets++;

                    IntPtr data;
                    uint frames;
                    uint flags;
                    ulong devicePosition;
                    ulong qpcPosition;
                    Check(capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition), "GetBuffer");

                    int bytes = (int)frames * blockAlign;
                    if (bytes > 0)
                    {
                        if ((flags & Interop.BufferFlagsSilent) != 0)
                        {
                            if (silence.Length < bytes) silence = new byte[bytes];
                            stdout.Write(silence, 0, bytes);
                        }
                        else
                        {
                            var managed = new byte[bytes];
                            Marshal.Copy(data, managed, 0, bytes);
                            stdout.Write(managed, 0, bytes);
                        }
                        stdout.Flush();
                        written += bytes;
                    }

                    Check(capture.ReleaseBuffer(frames), "ReleaseBuffer");
                }
            }

            client.Stop();
            Console.Error.WriteLine("captured " + written + " bytes");
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("error: " + e.Message);
            return 1;
        }
        finally
        {
            if (client != null) Marshal.ReleaseComObject(client);
        }
    }
}
