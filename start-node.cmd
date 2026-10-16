@echo off
rem 双击我，在**这台**机器上起一个班底「节点」—— 它主动连出到控制面。
rem
rem 控制面默认是本机的 8787。要连别的机器，先设 BANDI_CONTROL_PLANE：
rem   set BANDI_CONTROL_PLANE=http://192.168.1.9:8787
rem 走 SSH 隧道时也用它指到隧道那一头（见 deploy/README.md）。
rem
rem 控制面**监听非回环时会要求访问令牌**（令牌在控制面数据目录的 token 文件里）：
rem   set BANDI_NODE_TOKEN=<令牌>
rem 不设它也不会闷着 —— 报到被拒时会直接告诉你该设这个变量。
rem
rem 它领到活就在**这台机器**上起 agent CLI 跑，事件实时回传到控制面。
rem 派活的地方：控制面「设置 → 运行时 → 员工」，把 Runtime 选成带这台机器名的那条。
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 node。请先装 Node.js 22+，或者把 node 加进 PATH。
  echo.
  pause
  exit /b 1
)

if "%BANDI_CONTROL_PLANE%"=="" set "BANDI_CONTROL_PLANE=http://127.0.0.1:8787"

echo.
echo   班底节点 —— 控制面 %BANDI_CONTROL_PLANE%
echo   Ctrl-C 退出。退出满 45 秒后，控制面上这台会变成「离线」。
echo.

node "apps\server\src\node.mjs" %*
set CODE=%errorlevel%

rem 出错时别让窗口一闪而过，留给人看
if not "%CODE%"=="0" (
  echo.
  pause
)
exit /b %CODE%
