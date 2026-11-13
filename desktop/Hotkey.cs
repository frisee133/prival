using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// Raw Input with INPUTSINK delivers make/break while another application has focus.
// Only transitions for the selected virtual key leave this process.
sealed class Hotkey : NativeWindow {
    const int WM_INPUT=0xff, WM_CLOSE=0x10;
    [StructLayout(LayoutKind.Sequential)] struct Device { public ushort page,usage; public uint flags; public IntPtr target; }
    [StructLayout(LayoutKind.Sequential)] struct Header { public uint type,size; public IntPtr device,param; }
    [StructLayout(LayoutKind.Sequential)] struct Key { public ushort scan,flags,reserved,vk; public uint message,extra; }
    [DllImport("user32.dll", SetLastError=true)] static extern bool RegisterRawInputDevices(Device[] devices,uint count,uint size);
    [DllImport("user32.dll")] static extern uint GetRawInputData(IntPtr handle,uint command,IntPtr data,ref uint size,uint headerSize);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window,uint message,IntPtr w,IntPtr l);
    readonly int selected; bool down;
    Hotkey(int vk) {
        selected=vk;
        CreateHandle(new CreateParams { Caption="Prival PTT", Parent=new IntPtr(-3) });
        var device=new Device {page=1,usage=6,flags=0x100,target=Handle};
        if(!RegisterRawInputDevices(new[]{device},1,(uint)Marshal.SizeOf(typeof(Device))))throw new InvalidOperationException("Raw Input unavailable");
    }
    void Emit(bool value) { if(value==down)return;down=value; Console.WriteLine(value?"down":"up"); }
    protected override void WndProc(ref Message m) {
        if(m.Msg==WM_CLOSE){ Emit(false);Application.ExitThread(); }
        if(m.Msg==WM_INPUT){
            uint len=0,header=(uint)Marshal.SizeOf(typeof(Header));
            GetRawInputData(m.LParam,0x10000003,IntPtr.Zero,ref len,header);
            if(len>=header+16 && len<4096){
                IntPtr buf=Marshal.AllocHGlobal((int)len);
                try{if(GetRawInputData(m.LParam,0x10000003,buf,ref len,header)==len && Marshal.ReadInt32(buf)==1){
                    var k=(Key)Marshal.PtrToStructure(IntPtr.Add(buf,(int)header),typeof(Key));
                    if(k.vk==selected)Emit((k.flags&1)==0);
                }}finally{Marshal.FreeHGlobal(buf);}
            }
        }
        base.WndProc(ref m);
    }
    [STAThread] static int Main(string[] args) {
        int key;if(args.Length!=1||!int.TryParse(args[0],out key)||key<1||key>254)return 2;
        using(var output=new StreamWriter(Console.OpenStandardOutput()){AutoFlush=true}){
          Console.SetOut(output);var hook=new Hotkey(key);var handle=hook.Handle;
          new Thread(()=>{try{Console.ReadLine();}finally{PostMessage(handle,WM_CLOSE,IntPtr.Zero,IntPtr.Zero);}}){IsBackground=true}.Start();
          Console.WriteLine("ready");Application.Run();hook.DestroyHandle();
        }return 0;
    }
}
