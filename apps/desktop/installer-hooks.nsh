; 班底 · NSIS 钩子（Tauri 的 bundle.windows.nsis.installerHooks 指过来）
;
; 只有一件事：**卸载时多问一句 —— 要不要连数据一起删（完全卸载）**。
;
; 为什么要做成"选项"而不是默认删：数据目录里有库（会话、事件流、流程实例）、
; 访问令牌、插件与连接器配置、机器登记表。误删等于把用户的工作抹掉，
; 所以默认按钮是「否」，静默卸载（/S）也一律**不删**。
;
; ⚠️ 本文件必须是 **UTF-8 带 BOM**。Tauri 生成的 installer.nsi 里写着 `Unicode true`，
;    makensis 3 只认「带 BOM 的 UTF-8」或 ANSI —— 存成不带 BOM 的 UTF-8 会直接编译失败
;    （Bad text encoding）。改这个文件时别把 BOM 弄丢。
;
; ⚠️ 相对路径都要靠 $INSTDIR：这里只能引用**安装目录里**的东西。所以"删自启项"走安装目录里
;    那份 node.exe 去调 autostart.mjs（它知道自启文件落在哪），不自己拼路径。

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载器可能被提权拉起 —— 先把外壳变量钉在当前用户上，
  ; 否则 $APPDATA / $SMSTARTUP 会指到管理员的目录，等于删错地方、又没删干净。
  SetShellVarContext current

  ; 静默卸载不给删数据的机会（没人能回答这个问句）——直接跳过，保住数据。
  IfSilent bandi_keep_data

  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
    "要连数据一起删掉吗？$\r$\n$\r$\n【是 · 完全卸载】删除数字员工、会话与事件流、流程实例、访问令牌、插件与连接器配置、机器登记表、开机自启项 —— 删掉就回不来了。$\r$\n$\r$\n【否】只卸载程序，数据留着；下次装回来还是原来那个环境。$\r$\n$\r$\n（两种都不会动你在 ~/.ssh 里的密钥。）" \
    IDNO bandi_keep_data

  ; ── 1. 先把可能在跑的东西收掉 ────────────────────────────────────────────
  ; 自启那条 .cmd 是**带循环**的：光删文件它会把控制面再拉起来，库一直占着就删不干净。
  ; 只杀这三类进程（node / cmd / wscript）**并且**命令行里带本安装目录或 bandi-node 的 ——
  ; 不碰用户自己别的 node，也**不会误伤卸载器自己**（它叫 uninstall.exe，不在名单里）。
  ; ⚠️ 别想着用 $$PID 排除自己：那是 PowerShell 自己的 PID，不是卸载器的。
  nsExec::ExecToLog 'taskkill /F /IM "bandi-desktop.exe" /T'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /IM "班底.exe" /T'
  Pop $0
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Name -in @(''node.exe'',''cmd.exe'',''wscript.exe'') -and $$_.CommandLine -and ($$_.CommandLine -like ''*$INSTDIR*'' -or $$_.CommandLine -like ''*bandi-node*'') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Pop $0
  Sleep 1500

  ; ── 2. 撤掉开机自启（文件在 Startup 与 %APPDATA%\bandi-node） ──────────────
  nsExec::ExecToLog '"$INSTDIR\node.exe" "$INSTDIR\apps\server\src\autostart.mjs" remove'
  Pop $0

  ; ── 3. 数据与登记表 ──────────────────────────────────────────────────────
  RMDir /r "$APPDATA\bandi"         ; 控制面数据：库、访问令牌、端口、插件与连接器、日志、备份
  RMDir /r "$APPDATA\bandi-node"    ; 节点数据 + 自启脚本（.cmd）
  RMDir /r "$PROFILE\.bandi"        ; 服务器登记表 servers.yaml
  ; 自启项（autostart.mjs 已经删过，这里兜底）。
  ; ⚠️ 是 $SMSTARTUP 不是 $STARTUP —— NSIS 没有后者。上面那句 SetShellVarContext current
  ;    之后它指**当前用户**的启动文件夹（%APPDATA%\...\Start Menu\Programs\Startup）。
  Delete "$SMSTARTUP\bandi-control-plane.vbs"
  Delete "$SMSTARTUP\bandi-node.vbs"

  bandi_keep_data:
!macroend
