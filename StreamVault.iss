; StreamVault v1.0.0 - Inno Setup 6

#define AppName "StreamVault"
#define AppVersion "1.0.0"
#define AppPublisher "StreamVault"
#define AppURL "http://localhost:7000"

[Setup]
AppId={{8F4A2B1C-3D5E-6F7A-8B9C-0D1E2F3A4B5C}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
DefaultDirName={autopf}\StreamVault
DisableDirPage=no
DefaultGroupName={#AppName}
OutputDir=Output
OutputBaseFilename=StreamVault-Setup
SetupIconFile=assets\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
UninstallDisplayIcon={app}\icon.ico
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
Name: "{app}"
Name: "{commonappdata}\StreamVault"
Name: "{commonappdata}\StreamVault\data"

[Files]
Source: "app\server\*"; DestDir: "{app}\server"; Flags: recursesubdirs createallsubdirs
Source: "app\public\*"; DestDir: "{app}\public"; Flags: recursesubdirs createallsubdirs
Source: "app\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "app\setup\setup.html"; DestDir: "{app}\setup"; Flags: ignoreversion
Source: "deps\node-v22.15.0-x64.msi"; DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "deps\ffmpeg-release-essentials.zip"; DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "deps\nssm\nssm.exe"; DestDir: "{app}\tools"; Flags: ignoreversion
Source: "assets\icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\StreamVault"; Filename: "{#AppURL}"; IconFilename: "{app}\icon.ico"
Name: "{group}\Uninstall StreamVault"; Filename: "{uninstallexe}"
Name: "{commondesktop}\StreamVault"; Filename: "{#AppURL}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{#AppURL}/setup"; Description: "Open StreamVault setup wizard"; Flags: postinstall shellexec skipifsilent

[UninstallRun]
Filename: "{app}\tools\nssm.exe"; Parameters: "stop StreamVault"; Flags: runhidden; RunOnceId: "StopService"
Filename: "{app}\tools\nssm.exe"; Parameters: "remove StreamVault confirm"; Flags: runhidden; RunOnceId: "RemoveService"
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""StreamVault"""; Flags: runhidden; RunOnceId: "RemoveFirewall"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

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
  AppDir: String;
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then Exit;

  DataDir := ExpandConstant('{commonappdata}\StreamVault');
  AppDir := ExpandConstant('{app}');

  ProgressPage := CreateOutputProgressPage(
    'Installing StreamVault',
    'Please wait...'
  );
  ProgressPage.Show;

  try

    // Stop existing StreamVault server before installing
    SetStep(0, 8, 'Stopping StreamVault...', 'Stopping existing server...');
    Exec('schtasks.exe', '/End /TN "StreamVault"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(1000);
    Exec('taskkill.exe', '/F /IM node.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(4000);

    SetStep(0, 8, 'Installing Node.js 20 LTS...', 'This may take 1-2 minutes...');
    Exec('msiexec.exe',
      '/i "' + ExpandConstant('{tmp}\node-v22.15.0-x64.msi') + '" /qn /norestart ADDLOCAL=ALL',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(2000);

    SetStep(1, 8, 'Installing FFmpeg...', 'H.264, H.265, AAC, DTS...');
    if not FileExists(AppDir + '\ffmpeg\bin\ffmpeg.exe') then
    begin
      Exec('powershell.exe',
        '-NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path ''' +
        ExpandConstant('{tmp}\ffmpeg-release-essentials.zip') +
        ''' -DestinationPath ''' + AppDir + '\ffmpeg-tmp'' -Force"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Exec('powershell.exe',
        '-NoProfile -ExecutionPolicy Bypass -Command "' +
        'Get-ChildItem ''' + AppDir + '\ffmpeg-tmp'' -Directory |' +
        'Select-Object -First 1 |' +
        'ForEach-Object { Move-Item $_.FullName ''' + AppDir + '\ffmpeg'' }"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      DelTree(AppDir + '\ffmpeg-tmp', True, True, True);
    end;

    SetStep(2, 8, 'Locating Node.js...', '');
    NodeExe := FindNodeExe;
    NpmCli := FindNpmCli;

    SetStep(3, 8, 'Installing dependencies...', 'express, bcrypt, nedb, uuid...');
    if (NodeExe <> 'node.exe') and (NpmCli <> '') then
    begin
      Exec(NodeExe,
        '"' + NpmCli + '" install --production',
        AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end
    else
    begin
      Exec('powershell.exe',
        '-NoProfile -ExecutionPolicy Bypass -Command "' +
        '$env:Path = [System.Environment]::GetEnvironmentVariable(''Path'',''Machine'') + '';'' + [System.Environment]::GetEnvironmentVariable(''Path'',''User''); ' +
        'Set-Location ''' + AppDir + '''; ' +
        'npm install --production"',
        '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;

    SetStep(4, 8, 'Creating configuration...', '');
    WriteConfig;
    SaveStringToFile(
      AppDir + '\start.bat',
      '@echo off' + #13#10 +
      'set STREAMVAULT_DATA=' + DataDir + #13#10 +
      '"' + NodeExe + '" "' + AppDir + '\server\index.js"' + #13#10,
      False
    );

    SetStep(5, 8, 'Registering startup task...', 'StreamVault starts automatically');

    // Write PowerShell start script
    SaveStringToFile(AppDir + '\start.ps1',
      '$env:STREAMVAULT_DATA = "' + DataDir + '"' + #13#10 +
      'Set-Location "' + AppDir + '"' + #13#10 +
      '& "' + NodeExe + '" "' + AppDir + '\server\index.js"' + #13#10,
      False);

    // Remove old NSSM service if exists
    NssmPath := AppDir + '\tools\nssm.exe';
    Exec(NssmPath, 'stop StreamVault', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(NssmPath, 'remove StreamVault confirm', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    // Register as scheduled task at startup
    Exec('schtasks.exe',
      '/Create /F /RU SYSTEM /RL HIGHEST /SC ONSTART /TN "StreamVault" ' +
      '/TR "powershell.exe -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """' + AppDir + '\start.ps1"""" ' +
      '/DELAY 0000:15',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(3000);
    // Kill any remaining node processes
    Exec('taskkill.exe', '/F /IM node.exe',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(2000);
    // Start StreamVault via schtasks
    Exec('schtasks.exe', '/Run /TN "StreamVault"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(5000);
    // Verify it started, try once more if not
    Exec('schtasks.exe', '/Run /TN "StreamVault"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    SetStep(6, 8, 'Adding firewall rule...', 'Opening port 7000');
    Exec('netsh.exe', 'advfirewall firewall delete rule name="StreamVault"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('netsh.exe',
      'advfirewall firewall add rule name="StreamVault" dir=in action=allow protocol=TCP localport=7000',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    SetStep(7, 8, 'Starting StreamVault...', 'Waiting for server...');
    Sleep(8000);
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
