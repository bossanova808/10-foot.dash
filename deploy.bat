@echo off
call deploy-common.bat
if errorlevel 1 exit /b 1

echo Deploying to: kodidash
robocopy /MIR "dist" "C:\mnt\kodidash\home\appdata\nginx\www" /xd ".git"
if errorlevel 8 (
    echo Robocopy to kodidash failed!
    exit /b 1
)

rem echo Deploying to: dash.bossanova808.net
rem robocopy /MIR "dist" "C:\mnt\bossanova808-public-hs14\home\appdata\nginx\www" /xd ".git"
rem if errorlevel 8 (
rem     echo Robocopy to dash.bossanova808.net failed!
rem    exit /b 1
rem )
