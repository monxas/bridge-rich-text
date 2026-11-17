# Helpers for the Windows Word tests: dot-source, then use $word / Show-Word.
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class BridgeFg {
	[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
	[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
	[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
	[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
	[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
	[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
	[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
	public static string ForegroundClass() { var sb = new StringBuilder(64); GetClassName(GetForegroundWindow(), sb, 64); return sb.ToString(); }
	/* Windows only lets the foreground thread hand the focus over: borrow its input queue. */
	public static bool Focus(IntPtr h) {
		uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero), me = GetCurrentThreadId();
		bool attached = fg != me && AttachThreadInput(me, fg, true);
		/* The process that sent the last input may set the foreground: tap Alt (still on the old window). */
		keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
		ShowWindow(h, 9); BringWindowToTop(h); bool ok = SetForegroundWindow(h);
		if (attached) AttachThreadInput(me, fg, false);
		return ok;
	}
}
"@

function Get-Word {
	try { return [Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application") } catch { return $null }
}

function Show-Word($w) {
	$w.Visible = $true
	$w.Activate()
	$h = [IntPtr]$w.ActiveWindow.Hwnd
	for ($i = 0; $i -lt 10 -and [BridgeFg]::ForegroundClass() -ne "OpusApp"; $i++) {
		[BridgeFg]::Focus($h) | Out-Null
		Start-Sleep -Milliseconds 150
	}
	return [BridgeFg]::ForegroundClass()
}
