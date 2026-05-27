; StreamVault v1.0.0 - Inno Setup 6
; v10 - Fixed npm install, NSSM service, auto admin setup

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
  ProgramFiles: String;
begin
  Result := '';
  // Check registry first (most reliable after fresh install)
  if RegQueryStringValue(HKLM, 'SOFTWARE\Node.js', 'InstallPath', InstallPath) then
  begin
    if FileExists(InstallPath + '\node.exe') then
    begin
      Result := InstallPath + '\node.exe';
      Exit;
    end;
  end;
  // Check 64-bit registry
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Node.js', 'InstallPath', InstallPath) then
  begin
    if FileExists(InstallPath + '\node.exe') then
    begin
      Result := InstallPath + '\node.exe';
      Exit;
    end;
  end;
  // Common install locations
  ProgramFiles := 'C:\Program Files\nodejs\node.exe';
  if FileExists(ProgramFiles) then begin Result := ProgramFiles; Exit; end;
  ProgramFiles := 'C:\Program Files (x86)\nodejs\node.exe';
  if FileExists(ProgramFiles) then begin Result := ProgramFiles; Exit; end;
  // Last resort
  Result := 'node.exe';
end;

function FindNpmCmd: String;
var
  InstallPath: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\Node.js', 'InstallPath', InstallPath) then
  begin
    if FileExists(InstallPath + '\npm.cmd') then
    begin
      Result := InstallPath + '\npm.cmd';
      Exit;
    end;
  end;
  if FileExists('C:\Program Files\nodejs\npm.cmd') then begin Result := 'C:\Program Files\nodejs\npm.cmd'; Exit; end;
  Result := 'npm.cmd';
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
  NpmCmd: String;
  ResultCode: Integer;
  DataDir: String;
begin
  if CurStep <> ssPostInstall then Exit;

  DataDir := ExpandConstant('{commonappdata}\StreamVault');

  ProgressPage := CreateOutputProgressPage(
    'Installing StreamVault components',
    'Please wait while StreamVault is being configured...'
  );
  ProgressPage.Show;

  try

    // ── Step 1: Node.js ────────────────────────────────────────────────────────
    SetStep(0, 8, 'Installing Node.js 20 LTS...', 'This may take 1-2 minutes...');
    Exec('msiexec.exe',
      '/i "' + ExpandConstant('{tmp}\node-v20.14.0-x64.msi') + '" /qn /norestart ADDLOCAL=ALL',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    // Refresh environment so node is findable immediately
    Exec('cmd.exe', '/c setx PATH "%PATH%" /M', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(1000);

    // ── Step 2: FFmpeg ─────────────────────────────────────────────────────────
    SetStep(1, 8, 'Installing FFmpeg and codecs...', 'H.264, H.265, AV1, AAC, DTS, TrueHD...');
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

    // ── Step 3: Find Node + npm paths ──────────────────────────────────────────
    SetStep(2, 8, 'Locating Node.js installation...', '');
    NodeExe := FindNodeExe;
    NpmCmd := FindNpmCmd;

    // ── Step 4: npm install ────────────────────────────────────────────────────
    SetStep(3, 8, 'Installing Node.js dependencies...', 'express, bcrypt, sqlite3...');

    // Use full path to npm to avoid PATH issues
    if FileExists(NpmCmd) then
    begin
      Exec('cmd.exe',
        '/c "' + NpmCmd + '" install --production --prefix "' + ExpandConstant('{#InstallDir}') + '"',
        ExpandConstant('{#InstallDir}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end
    else
    begin
      // Fallback: use node directly with npm script
      Exec(NodeExe,
        '"C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" install --production',
        ExpandConstant('{#InstallDir}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;

    // ── Step 5: Write config ───────────────────────────────────────────────────
    SetStep(4, 8, 'Creating configuration...', '');
    WriteConfig;

    // Write env file so server knows where data is
    SaveStringToFile(
      ExpandConstant('{#InstallDir}\streamvault.env'),
      'STREAMVAULT_DATA=' + DataDir,
      False
    );

    // Write start.bat
    SaveStringToFile(
      ExpandConstant('{#InstallDir}\start.bat'),
      '@echo off' + #13#10 +
      'set STREAMVAULT_DATA=' + DataDir + #13#10 +
      '"' + NodeExe + '" "' + ExpandConstant('{#InstallDir}\server\index.js') + '"' + #13#10,
      False
    );

    // ── Step 6: Windows Service via NSSM ──────────────────────────────────────
    SetStep(5, 8, 'Registering Windows service...', 'StreamVault will start automatically with Windows');
    NssmPath := ExpandConstant('{#InstallDir}\tools\nssm.exe');

    // Remove old service if exists
    Exec(NssmPath, 'stop StreamVault', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'remove StreamVault confirm', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    // Install service with full paths
    Exec(NssmPath,
      'install StreamVault "' + NodeExe + '" "' + ExpandConstant('{#InstallDir}\server\index.js') + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath,
      'set StreamVault AppDirectory "' + ExpandConstant('{#InstallDir}') + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath,
      'set StreamVault AppEnvironmentExtra "STREAMVAULT_DATA=' + DataDir + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'set StreamVault Description "StreamVault Media Server"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'set StreamVault Start SERVICE_AUTO_START',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath,
      'set StreamVault AppStdout "' + DataDir + '\streamvault.log"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath,
      'set StreamVault AppStderr "' + DataDir + '\error.log"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'start StreamVault', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    // ── Step 7: Firewall ───────────────────────────────────────────────────────
    SetStep(6, 8, 'Adding firewall rule...', 'Opening port 7000');
    Exec('netsh.exe',
      'advfirewall firewall delete rule name="StreamVault"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('netsh.exe',
      'advfirewall firewall add rule name="StreamVault" dir=in action=allow protocol=TCP localport=7000',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    // ── Step 8: Wait and open setup wizard ────────────────────────────────────
    SetStep(7, 8, 'Starting StreamVault...', 'Waiting for server to start...');
    Sleep(5000);
    SetStep(8, 8, 'Done!', 'StreamVault is ready');

  finally
    ProgressPage.Hide;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  if MsgBox(
    'Do you also want to remove StreamVault data?' + #13#10 +
    '(Library settings, user accounts, watch history)',
    mbConfirmation, MB_YESNO) = IDYES then
  begin
    DelTree(ExpandConstant('{commonappdata}\StreamVault'), True, True, True);
  end;
  Exec('netsh.exe', 'advfirewall firewall delete rule name="StreamVault"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
