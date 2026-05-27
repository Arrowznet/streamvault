@echo off
title StreamVault - Bygger installeraren
color 0A
echo.
echo  =====================================================
echo   StreamVault Setup Builder
echo   Bygger StreamVault-Setup.exe...
echo  =====================================================
echo.

:: Hitta Inno Setup
set INNO=""
if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set INNO="C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if exist "C:\Program Files\Inno Setup 6\ISCC.exe" set INNO="C:\Program Files\Inno Setup 6\ISCC.exe"

if %INNO%=="" (
    echo  [FEL] Inno Setup hittades inte!
    echo  Installera fran: https://jrsoftware.org/isdl.php
    pause
    exit /b 1
)

echo  [OK] Inno Setup hittad.
echo.

:: Kontrollera att beroenden finns
echo  Kontrollerar filer...

if not exist "deps\node-v20.14.0-x64.msi" (
    echo  [FEL] Saknar: deps\node-v20.14.0-x64.msi
    echo  Ladda ner fran: https://nodejs.org/dist/v20.14.0/node-v20.14.0-x64.msi
    pause
    exit /b 1
)

if not exist "deps\ffmpeg-release-essentials.zip" (
    echo  [FEL] Saknar: deps\ffmpeg-release-essentials.zip
    echo  Ladda ner fran: https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
    pause
    exit /b 1
)

if not exist "deps\nssm\nssm.exe" (
    echo  [FEL] Saknar: deps\nssm\nssm.exe
    echo  Se LÄSMIG.md for instruktioner
    pause
    exit /b 1
)

if not exist "app\server\index.js" (
    echo  [FEL] Saknar StreamVault-serverfilerna i app\
    pause
    exit /b 1
)

echo  [OK] Alla filer hittade.
echo.
echo  Bygger StreamVault-Setup.exe...
echo  (Detta tar 1-2 minuter)
echo.

:: Skapa output-mapp
if not exist "Output" mkdir Output

:: Kör Inno Setup compiler
%INNO% StreamVault.iss

if %errorlevel% neq 0 (
    echo.
    echo  [FEL] Bygget misslyckades! Se felmeddelande ovan.
    pause
    exit /b 1
)

echo.
echo  =====================================================
echo   Klart! Din installerare finns har:
echo   Output\StreamVault-Setup.exe
echo  =====================================================
echo.

:: Öppna output-mappen
explorer Output

pause
