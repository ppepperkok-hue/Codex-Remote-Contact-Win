param(
    [Parameter(Mandatory=$true, Position=0)][string]$Action,
    [Parameter(Position=1)][string]$Arg1,
    [Parameter(Position=2)][string]$Arg2
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GuiNative {
    [DllImport("user32.dll", CharSet=CharSet.Auto)]
    public static extern void SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
"@

function Send-MouseClick([int]$X, [int]$Y) {
    [GuiNative]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 120
    [GuiNative]::mouse_event(0x02, 0, 0, 0, [UIntPtr]::Zero)  # left down
    Start-Sleep -Milliseconds 60
    [GuiNative]::mouse_event(0x04, 0, 0, 0, [UIntPtr]::Zero)  # left up
    Start-Sleep -Milliseconds 120
}

function Send-Type([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return }
    [System.Windows.Forms.SendKeys]::SendWait($Text)
}

switch ($Action.ToLower()) {
    "click" {
        $x = [int]$Arg1
        $y = [int]$Arg2
        Send-MouseClick $x $y
        Write-Output "clicked $x,$y"
    }
    "move" {
        [GuiNative]::SetCursorPos([int]$Arg1, [int]$Arg2)
        Write-Output "moved to $Arg1,$Arg2"
    }
    "type" {
        Send-Type $Arg1
        Write-Output "typed"
    }
    "key" {
        $key = $Arg1
        if ($key -eq "enter") { $key = "{ENTER}" }
        elseif ($key -eq "tab") { $key = "{TAB}" }
        elseif ($key -eq "esc") { $key = "{ESC}" }
        elseif ($key -eq "space") { $key = " " }
        elseif ($key -eq "backspace") { $key = "{BACKSPACE}" }
        elseif ($key -eq "ctrl+a") { $key = "^a" }
        elseif ($key -eq "ctrl+c") { $key = "^c" }
        elseif ($key -eq "ctrl+v") { $key = "^v" }
        elseif ($key -eq "ctrl+s") { $key = "^s" }
        elseif ($key -eq "alt+tab") { $key = "%{TAB}" }
        elseif ($key -eq "win") { $key = "{LWIN}" }
        elseif ($key -eq "media_play_pause") { $key = "{MEDIA_PLAY_PAUSE}" }
        elseif ($key -eq "media_next") { $key = "{MEDIA_NEXT_TRACK}" }
        elseif ($key -eq "media_prev") { $key = "{MEDIA_PREV_TRACK}" }
        elseif ($key -eq "f5") { $key = "{F5}" }
        elseif ($key -eq "f11") { $key = "{F11}" }
        [System.Windows.Forms.SendKeys]::SendWait($key)
        Write-Output "sent $Arg1"
    }
    "activate" {
        $proc = Get-Process -Name $Arg1 -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($proc) {
            $hwnd = $proc.MainWindowHandle
            if ($hwnd -ne [IntPtr]::Zero) {
                [GuiNative]::SetForegroundWindow($hwnd) | Out-Null
                Write-Output "activated $Arg1"
            } else {
                Write-Output "no window for $Arg1"
            }
        } else {
            Write-Output "no process $Arg1"
        }
    }
    "foreground" {
        $hwnd = [GuiNative]::GetForegroundWindow()
        $proc = Get-Process | Where-Object { $_.MainWindowHandle -eq $hwnd } | Select-Object -First 1
        if ($proc) { Write-Output $proc.ProcessName } else { Write-Output "unknown" }
    }
    "describe" {
        $out = Join-Path $env:TEMP ("screen-" + [DateTime]::Now.ToString("yyyyMMddHHmmss") + ".png")
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose()
        $bmp.Dispose()
        $prompt = if ($Arg1) { $Arg1 } else { "Describe this desktop screenshot concisely in Chinese. List visible windows and UI elements with rough positions (e.g. left/center/right, top/middle/bottom)." }
        $py = if ($env:CODEX_VISION_PY) { $env:CODEX_VISION_PY } else { Join-Path $env:USERPROFILE ".codex\skills\vision\vision.py" }
        if (-not (Test-Path $py)) {
            $py = Join-Path $env:USERPROFILE ".agents\skills\vision\vision.py"
        }
        if (-not (Test-Path $py)) {
            Write-Output "vision.py not found; set CODEX_VISION_PY"
            exit 1
        }
        if (-not $env:DASHSCOPE_API_KEY) {
            Write-Output "DASHSCOPE_API_KEY not configured"
            exit 1
        }
        $env:DASHSCOPE_BASE_URL = if ($env:DASHSCOPE_BASE_URL) { $env:DASHSCOPE_BASE_URL } else { "https://dashscope.aliyuncs.com/compatible-mode/v1" }
        $desc = & python $py --provider qwen $out $prompt 2>&1 | Out-String
        Write-Output $desc.Trim()
    }
    default {
        Write-Output "usage: gui-control.ps1 click <x> <y> | move <x> <y> | type <text> | key <name> | activate <process> | foreground | describe [prompt]"
        exit 1
    }
}
