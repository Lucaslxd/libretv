@echo off
chcp 65001 >nul
setlocal EnableExtensions
title LibreTV Server

rem ============================================================
rem  LibreTV server launcher
rem  PORT     : change if 8080 is already in use
rem  PASSWORD : enabled. Change the value below to your own password.
rem ============================================================

set "ROOT=%~dp0"
set "PORT=8080"
set "PASSWORD=123123"
set "HOSTNAME=0.0.0.0"

rem  DEFAULT_SOURCES : built-in VOD sources (JSON array of name/url)
set "DEFAULT_SOURCES=[{"name":"电影天堂","url":"http://caiji.dyttzyapi.com/api.php/provide/vod"},{"name":"非凡影视","url":"https://api.ffzyapi.com/api.php/provide/vod"},{"name":"极速资源","url":"https://jszyapi.com/api.php/provide/vod"},{"name":"魔都资源","url":"https://www.mdzyapi.com/api.php/provide/vod"},{"name":"最大资源","url":"https://api.zuidapi.com/api.php/provide/vod"},{"name":"量子资源","url":"https://cj.lziapi.com/api.php/provide/vod"},{"name":"百度资源","url":"https://api.apibdzy.com/api.php/provide/vod"},{"name":"新浪资源","url":"https://api.xinlangapi.com/xinlangapi.php/provide/vod"},{"name":"速博资源","url":"https://subocaiji.com/api.php/provide/vod"},{"name":"猫眼资源","url":"https://api.maoyanapi.top/api.php/provide/vod"},{"name":"360资源","url":"https://360zyzz.com/api.php/provide/vod"}]"

if not exist "%ROOT%logs" mkdir "%ROOT%logs" >nul 2>&1

set "NODE=%ROOT%runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

cd /d "%ROOT%app"
echo [LibreTV] 本机访问  http://127.0.0.1:%PORT%/
echo [LibreTV] 局域网    http://192.168.1.16:%PORT%/
echo [LibreTV] 直播聚合  http://192.168.1.16:%PORT%/live-agg/
echo [LibreTV] (close this window to stop)
"%NODE%" gateway.js
echo.
echo [LibreTV] server stopped.
timeout /t 3 >nul
endlocal
