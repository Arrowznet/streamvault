; StreamVault v1.0.0 - Inno Setup 6
; v11 - Fixed npm install using full path

#define AppName "StreamVault"
#define AppVersion "1.0.0"
#define AppPublisher "StreamVault"
#define AppURL "http://localhost:7000"
#define InstallDir "C:\StreamVault"

[Setup]
AppId={{8F4A2B1C-3D5E-6F7A-8B9C-0D1E2F3A4B5C}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
DefaultDirName={#InstallDir}
DisableDirPage=yes
DefaultGroupName={#AppName}
OutputDir=Output
OutputBaseFilename=StreamVault-Setup
SetupIconFile=assets\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
UninstallDisplayIcon={#InstallDir}\icon.ico
UninstallDisplayName={#AppName}
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=StreamVault Media Server
MinVersion=10.0
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create desktop shortcut"; GroupDescription: "Options:"

[Dirs]
Name: "{#InstallDir}"
Name: "{commonappdata}\StreamVault"
Name: "{commonappdata}\StreamVault\data"

[Files]
Source: "app\server\*"; DestDir: "{#InstallDir}\server"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "app\public\*"; DestDir: "{#InstallDir}\public"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "app\package.json"; DestDir: "{#InstallDir}"; Flags: ignoreversion
Source: "app\setup\setup.html"; DestDir: "{#InstallDir}\setup"; Flags: ignoreversion
Source: "deps\node-v20.14.0-x64.msi"; DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "deps\ffmpeg-release-essentials.zip"; DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "deps\nssm\nssm.exe"; DestDir: "{#InstallDir}\tools"; Flags: ignoreversion
Source: "assets\icon.ico"; DestDir: "{#InstallDir}"; Flags: ignoreversion

[Icons]
Name: "{group}\StreamVault"; Filename: "{#AppURL}"; IconFilename: "{#InstallDir}\icon.ico"
Name: "{group}\Uninstall StreamVault"; Filename: "{uninstallexe}"
Name: "{commondesktop}\StreamVault"; Filename: "{#AppURL}"; IconFilename: "{#InstallDir}\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{#AppURL}/setup"; Description: "Open StreamVault setup wizard"; Flags: postinstall shellexec skipifsilent

[UninstallRun]
Filename: "{#InstallDir}\tools\nssm.exe"; Parameters: "stop StreamVault"; Flags: runhidden; RunOnceId: "StopService"
Filename: "{#InstallDir}\tools\nssm.exe"; Parameters: "remove StreamVault confirm"; Flags: runhidden; RunOnceId: "RemoveService"
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""StreamVault"""; Flags: runhidden; RunOnceId: "RemoveFirewall"

[UninstallDelete]
Type: filesandordirs; Name: "{#InstallDir}"

[Code]

var
  ProgressPage: TOutputProgressWizardPage;

procedure SetStep(Step: Integer; Total: Integer; Msg: String; Detail: String);
begin
  ProgressPage.SetText(Msg, Detail);
  ProgressPage.SetProgress(Step, Total);
end;

function FindNodeExe: String;
var
  InstallPath: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\Node.js', 'InstallPath', InstallPath) then
    if FileExists(InstallPath + '\node.exe') then begin Result := InstallPath + '\node.exe'; Exit; end;
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Node.js', 'InstallPath', InstallPath) then
    if FileExists(InstallPath + '\node.exe') then begin Result := InstallPath + '\node.exe'; Exit; end;
  if FileExists('C:\Program Files\nodejs\node.exe') then begin Result := 'C:\Program Files\nodejs\node.exe'; Exit; end;
  if FileExists('C:\Program Files (x86)\nodejs\node.exe') then begin Result := 'C:\Program Files (x86)\nodejs\node.exe'; Exit; end;
  Result := 'node.exe';
end;

function FindNpmCli: String;
var
  InstallPath: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\Node.js', 'InstallPath', InstallPath) then
    if FileExists(InstallPath + '\node_modules\npm\bin\npm-cli.js') then begin Result := InstallPath + '\node_modules\npm\bin\npm-cli.js'; Exit; end;
  if FileExists('C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js') then begin Result := 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'; Exit; end;
  Result := '';
end;

procedure WriteConfig;
var
  Json: String;
  DataPath: String;
begin
  DataPath := ExpandConstant('{commonappdata}\StreamVault\data\config.json');
  if FileExists(DataPath) then Exit;
  Json :=
    '{' + #13#10 +
    '  "port": 7000,' + #13#10 +
    '  "jwt_secret": "sv_auto_generated_change_me",' + #13#10 +
    '  "tmdb_api_key": "",' + #13#10 +
    '  "opensubtitles_api_key": "",' + #13#10 +
    '  "language": "auto",' + #13#10 +
    '  "transcoding": { "enabled": true, "hardware_accel": "auto" },' + #13#10 +
    '  "libraries": []' + #13#10 +
    '}';
  SaveStringToFile(DataPath, Json, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  NssmPath: String;
  NodeExe: String;
  NpmCli: String;
  DataDir: String;
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then Exit;

  DataDir := ExpandConstant('{commonappdata}\StreamVault');

  ProgressPage := CreateOutputProgressPage(
    'Installing StreamVault',
    'Please wait...'
  );
  ProgressPage.Show;

  try

    // ── Step 1: Node.js ────────────────────────────────────────────────────────
    SetStep(0, 8, 'Installing Node.js 20 LTS...', 'This may take 1-2 minutes...');
    Exec('msiexec.exe',
      '/i "' + ExpandConstant('{tmp}\node-v20.14.0-x64.msi') + '" /qn /norestart ADDLOCAL=ALL',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(2000);

    // ── Step 2: FFmpeg ─────────────────────────────────────────────────────────
    SetStep(1, 8, 'Installing FFmpeg and codecs...', 'H.264, H.265, AV1, AAC, DTS...');
    if not FileExists(ExpandConstant('{#InstallDir}\ffmpeg\bin\ffmpeg.exe')) then
    begin
      Exec('powershell.exe',
        '-NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path ''' +
        ExpandConstant('{tmp}\ffmpeg-release-essentials.zip') +
        ''' -DestinationPath ''' + ExpandConstant('{#InstallDir}\ffmpeg-tmp') + ''' -Force"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Exec('powershell.exe',
        '-NoProfile -ExecutionPolicy Bypass -Command "' +
        'Get-ChildItem ''' + ExpandConstant('{#InstallDir}\ffmpeg-tmp') + ''' -Directory |' +
        'Select-Object -First 1 |' +
        'ForEach-Object { Move-Item $_.FullName ''' + ExpandConstant('{#InstallDir}\ffmpeg') + ''' }"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      DelTree(ExpandConstant('{#InstallDir}\ffmpeg-tmp'), True, True, True);
    end;

    // ── Step 3: Find Node paths ────────────────────────────────────────────────
    SetStep(2, 8, 'Locating Node.js...', '');
    NodeExe := FindNodeExe;
    NpmCli := FindNpmCli;

    // ── Step 4: npm install using full path to node + npm-cli.js ──────────────
    SetStep(3, 8, 'Installing dependencies...', 'express, bcrypt, sqlite3...');
    if (NodeExe <> 'node.exe') and (NpmCli <> '') then
    begin
      // Best method: node + npm-cli.js with full paths
      Exec(NodeExe,
        '"' + NpmCli + '" install --production',
        ExpandConstant('{#InstallDir}'),
        SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end
    else
    begin
      // Fallback: use powershell to run npm with refreshed PATH
      Exec('powershell.exe',
        '-NoProfile -ExecutionPolicy Bypass -Command "' +
        '$env:Path = [System.Environment]::GetEnvironmentVariable(''Path'',''Machine'') + '';'' + [System.Environment]::GetEnvironmentVariable(''Path'',''User''); ' +
        'Set-Location ''' + ExpandConstant('{#InstallDir}') + '''; ' +
        'npm install --production"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;

    // ── Step 5: Write config ───────────────────────────────────────────────────
    SetStep(4, 8, 'Creating configuration...', '');
    WriteConfig;
    SaveStringToFile(
      ExpandConstant('{#InstallDir}\start.bat'),
      '@echo off' + #13#10 +
      'set STREAMVAULT_DATA=' + DataDir + #13#10 +
      '"' + NodeExe + '" "' + ExpandConstant('{#InstallDir}\server\index.js') + '"' + #13#10,
      False
    );

    // ── Step 6: Windows Service ────────────────────────────────────────────────
    SetStep(5, 8, 'Registering Windows service...', 'StreamVault will start automatically');
    NssmPath := ExpandConstant('{#InstallDir}\tools\nssm.exe');
    Exec(NssmPath, 'stop StreamVault', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'remove StreamVault confirm', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath,
      'install StreamVault "' + NodeExe + '" "' + ExpandConstant('{#InstallDir}\server\index.js') + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'set StreamVault AppDirectory "' + ExpandConstant('{#InstallDir}') + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'set StreamVault AppEnvironmentExtra "STREAMVAULT_DATA=' + DataDir + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'set StreamVault Description "StreamVault Media Server"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'set StreamVault Start SERVICE_AUTO_START',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'set StreamVault AppStdout "' + DataDir + '\streamvault.log"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'set StreamVault AppStderr "' + DataDir + '\error.log"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'start StreamVault', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    // ── Step 7: Firewall ───────────────────────────────────────────────────────
    SetStep(6, 8, 'Adding firewall rule...', 'Opening port 7000');
    Exec('netsh.exe', 'advfirewall firewall delete rule name="StreamVault"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('netsh.exe',
      'advfirewall firewall add rule name="StreamVault" dir=in action=allow protocol=TCP localport=7000',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    // ── Step 8: Done ───────────────────────────────────────────────────────────
    SetStep(7, 8, 'Starting StreamVault...', 'Waiting for server...');
    Sleep(5000);
    SetStep(8, 8, 'Installation complete!', '');

  finally
    ProgressPage.Hide;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  if MsgBox('Do you also want to remove StreamVault data?' + #13#10 +
    '(Library settings, user accounts, watch history)',
    mbConfirmation, MB_YESNO) = IDYES then
    DelTree(ExpandConstant('{commonappdata}\StreamVault'), True, True, True);
  Exec('netsh.exe', 'advfirewall firewall delete rule name="StreamVault"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
