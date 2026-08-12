#ifndef ReleaseVersion
  #error ReleaseVersion must be provided by scripts/build-release.ps1
#endif

#ifndef PayloadRoot
  #error PayloadRoot must be provided by scripts/build-release.ps1
#endif

#ifndef TargetArchitecture
  #error TargetArchitecture must be provided by scripts/build-release.ps1
#endif

#if TargetArchitecture != "x64"
  #if TargetArchitecture != "arm64"
    #error TargetArchitecture must be x64 or arm64
  #endif
#endif

#define ExtensionId "cakpfifpfmbdcilimpedanglnopnmckg"
#define NativeHostName "com.videoradar.helper"

[Setup]
AppId={{7A5C59C3-0DCE-4D0C-9BE1-5621E2AA4EA4}
AppName=Video Radar
AppVersion={#ReleaseVersion}
AppVerName=Video Radar {#ReleaseVersion}
AppPublisher=Carlos
AppPublisherURL=https://github.com/carlosesl1/videodownloader
AppSupportURL=https://github.com/carlosesl1/videodownloader/issues
AppUpdatesURL=https://github.com/carlosesl1/videodownloader/releases
DefaultDirName={localappdata}\VideoRadar
DefaultGroupName=Video Radar
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
SetupArchitecture=x64
#if TargetArchitecture == "x64"
ArchitecturesAllowed=x64compatible and not arm64
ArchitecturesInstallIn64BitMode=x64compatible and not arm64
MinVersion=10.0.17763
#else
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
MinVersion=10.0.22000
#endif
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
LicenseFile={#PayloadRoot}\legal\LICENSE
UninstallDisplayName=Video Radar
UninstallDisplayIcon={app}\Extension\assets\icon-128.png
VersionInfoVersion={#ReleaseVersion}.0
VersionInfoCompany=Carlos
VersionInfoDescription=Video Radar installer
VersionInfoProductName=Video Radar
VersionInfoProductVersion={#ReleaseVersion}
ChangesEnvironment=no
CloseApplications=yes
RestartApplications=no
RestartIfNeededByRun=no
SetupMutex=Local\VideoRadarInstall-7A5C59C3-0DCE-4D0C-9BE1-5621E2AA4EA4
UsePreviousAppDir=yes

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "{#PayloadRoot}\Extension\*"; DestDir: "{app}\Extension"; Flags: ignoreversion recursesubdirs createallsubdirs; BeforeInstall: MarkPayloadInstallStarted
Source: "{#PayloadRoot}\host\*"; DestDir: "{app}\host"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\legal\*"; DestDir: "{app}\legal"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\onboarding\*"; DestDir: "{app}\onboarding"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\build-info.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{tmp}\VideoRadar-install\{#NativeHostName}.json"; DestDir: "{app}\native-host"; Flags: external ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.videoradar.helper"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host\{#NativeHostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.videoradar.helper"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host\{#NativeHostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.videoradar.helper"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host\{#NativeHostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Vivaldi\NativeMessagingHosts\com.videoradar.helper"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host\{#NativeHostName}.json"; Flags: uninsdeletekey

[Icons]
Name: "{group}\Como instalar no navegador"; Filename: "{app}\onboarding\index.html"; WorkingDir: "{app}\onboarding"
Name: "{group}\Pasta da extensão"; Filename: "{app}\Extension"
Name: "{group}\Desinstalar Video Radar"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\onboarding\index.html"; Description: "Abrir o guia de instalação no navegador"; WorkingDir: "{app}\onboarding"; Flags: postinstall shellexec skipifsilent
Filename: "{app}\Extension"; Description: "Abrir a pasta Extension"; WorkingDir: "{app}"; Flags: postinstall shellexec skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\native-host"
Type: dirifempty; Name: "{app}"

[Code]
var
  PreparationComplete: Boolean;
  BackupOwned: Boolean;
  PayloadInstallStarted: Boolean;
  InstallSucceeded: Boolean;
  BackupRoot: String;

function AppComponentPath(const RelativePath: String): String;
begin
  Result := AddBackslash(ExpandConstant('{app}')) + RelativePath;
end;

function BackupComponentPath(const RelativePath: String): String;
begin
  Result := AddBackslash(BackupRoot) + RelativePath;
end;

procedure AssertNotReparsePoint(const Path: String);
var
  FindRec: TFindRec;
begin
  if not FindFirst(Path, FindRec) then
    RaiseException('Não foi possível inspecionar ' + Path + '.');
  try
    if (FindRec.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) <> 0 then
      RaiseException('A instalação existente contém um link não permitido: ' +
        Path + '.');
  finally
    FindClose(FindRec);
  end;
end;

procedure CopyDirectoryTree(const SourceDir: String; const DestinationDir: String);
var
  FindRec: TFindRec;
  SourcePath: String;
  DestinationPath: String;
begin
  if not ForceDirectories(DestinationDir) then
    RaiseException('Não foi possível criar o backup em ' + DestinationDir + '.');
  if FindFirst(AddBackslash(SourceDir) + '*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          SourcePath := AddBackslash(SourceDir) + FindRec.Name;
          DestinationPath := AddBackslash(DestinationDir) + FindRec.Name;
          if (FindRec.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) <> 0 then
            RaiseException('A instalação existente contém um link não permitido: ' +
              SourcePath + '.');
          if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
            CopyDirectoryTree(SourcePath, DestinationPath)
          else if not CopyFile(SourcePath, DestinationPath, True) then
            RaiseException('Não foi possível copiar ' + SourcePath +
              ' para o backup.');
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

procedure CopyOwnedComponent(const RelativePath: String);
var
  SourcePath: String;
  DestinationPath: String;
begin
  SourcePath := AppComponentPath(RelativePath);
  DestinationPath := BackupComponentPath(RelativePath);
  if DirExists(SourcePath) then
  begin
    AssertNotReparsePoint(SourcePath);
    CopyDirectoryTree(SourcePath, DestinationPath);
  end
  else if FileExists(SourcePath) then
  begin
    AssertNotReparsePoint(SourcePath);
    if not ForceDirectories(ExtractFileDir(DestinationPath)) then
      RaiseException('Não foi possível preparar o backup de ' + RelativePath + '.');
    if not CopyFile(SourcePath, DestinationPath, True) then
      RaiseException('Não foi possível copiar ' + RelativePath + ' para o backup.');
  end;
end;

procedure PrepareBackup;
begin
  { This sibling stays on the same volume even when Setup receives /DIR=. }
  BackupRoot := ExpandConstant('{app}.runtime-backup');
  if DirExists(BackupRoot) or FileExists(BackupRoot) then
    RaiseException('Existe um backup pendente em ' + BackupRoot +
      '. Preserve-o para recuperação antes de executar o instalador novamente.');
  if not ForceDirectories(BackupRoot) then
    RaiseException('Não foi possível criar o backup transacional da instalação.');
  BackupOwned := True;

  { Never copy or move the shared root: state and partial downloads stay put. }
  CopyOwnedComponent('Extension');
  CopyOwnedComponent('host');
  CopyOwnedComponent('licenses');
  CopyOwnedComponent('legal');
  CopyOwnedComponent('onboarding');
  CopyOwnedComponent('native-host');
  CopyOwnedComponent('build-info.json');
end;

procedure CleanupBackupCopy;
begin
  if not BackupOwned then
    Exit;
  if (not DirExists(BackupRoot)) or DelTree(BackupRoot, True, True, True) then
    BackupOwned := False
  else
    Log('Não foi possível remover o backup em ' + BackupRoot + '.');
end;

function JsonEscape(const Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
end;

procedure WriteNativeManifest(const ManifestPath: String);
var
  HostPath: String;
  Lines: TArrayOfString;
begin
  HostPath := ExpandConstant('{app}\host\video-radar-host.exe');
  if not ForceDirectories(ExtractFileDir(ManifestPath)) then
    RaiseException('Não foi possível criar a pasta do manifesto nativo.');

  SetArrayLength(Lines, 9);
  Lines[0] := '{';
  Lines[1] := '  "name": "{#NativeHostName}",';
  Lines[2] := '  "description": "Auxiliar local do Vídeo Radar",';
  Lines[3] := '  "path": "' + JsonEscape(HostPath) + '",';
  Lines[4] := '  "type": "stdio",';
  Lines[5] := '  "allowed_origins": [';
  Lines[6] := '    "chrome-extension://cakpfifpfmbdcilimpedanglnopnmckg/"';
  Lines[7] := '  ]';
  Lines[8] := '}';
  if not SaveStringsToUTF8FileWithoutBOM(ManifestPath, Lines, False) then
    RaiseException('Não foi possível gravar o manifesto nativo.');
end;

procedure VerifyNativeHost(const HostRoot: String);
var
  HostPath: String;
  ResultCode: Integer;
begin
  HostPath := AddBackslash(HostRoot) + 'video-radar-host.exe';
  if not Exec(HostPath, '--ping', HostRoot, SW_HIDE,
    ewWaitUntilTerminated, ResultCode) then
  begin
    RaiseException('O auxiliar local não pôde ser iniciado: ' +
      SysErrorMessage(ResultCode));
  end;
  if ResultCode <> 0 then
    RaiseException('O diagnóstico do auxiliar local falhou. Código: ' +
      IntToStr(ResultCode));
end;

procedure ExtractAndVerifyNativeHost;
var
  TemporaryHostRoot: String;
begin
  { Extract the same embedded bytes that [Files] will install. The unexpanded
    application constant follows ExtractTemporaryFiles' documented convention. }
  ExtractTemporaryFiles('{app}\host\video-radar-host.exe');
  ExtractTemporaryFiles('{app}\host\tools\*.exe');
  TemporaryHostRoot := AddBackslash(ExpandConstant('{tmp}')) + '{app}\host';
  VerifyNativeHost(TemporaryHostRoot);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ManifestPath: String;
begin
  if PreparationComplete then
  begin
    Result := '';
    Exit;
  end;

  try
    ExtractAndVerifyNativeHost;
    ManifestPath := ExpandConstant('{tmp}\VideoRadar-install\{#NativeHostName}.json');
    WriteNativeManifest(ManifestPath);
    PrepareBackup;
    PreparationComplete := True;
    Result := '';
  except
    Result := 'A instalação foi interrompida antes de alterar a versão atual. ' +
      GetExceptionMessage;
    Log('PrepareToInstall falhou: ' + GetExceptionMessage);
    CleanupBackupCopy;
  end;
end;

procedure MarkPayloadInstallStarted;
begin
  { Wildcard BeforeInstall calls can repeat; assigning True is idempotent. }
  PayloadInstallStarted := True;
end;

function RemoveActiveComponent(const Path: String): Boolean;
begin
  if DirExists(Path) then
    Result := DelTree(Path, True, True, True)
  else if FileExists(Path) then
    Result := DeleteFile(Path)
  else
    Result := True;
end;

procedure RestoreOwnedComponent(const RelativePath: String;
  var RestoreFailed: Boolean);
var
  ActivePath: String;
  SavedPath: String;
  SavedExists: Boolean;
begin
  ActivePath := AppComponentPath(RelativePath);
  SavedPath := BackupComponentPath(RelativePath);
  SavedExists := DirExists(SavedPath) or FileExists(SavedPath);
  if not RemoveActiveComponent(ActivePath) then
  begin
    RestoreFailed := True;
    Log('Rollback: não foi possível remover a substituição parcial de ' +
      RelativePath + '.');
    Exit;
  end;

  if SavedExists then
  begin
    if not ForceDirectories(ExtractFileDir(ActivePath)) then
    begin
      RestoreFailed := True;
      Log('Rollback: não foi possível recriar o destino de ' + RelativePath + '.');
    end
    else if not RenameFile(SavedPath, ActivePath) then
    begin
      RestoreFailed := True;
      Log('Rollback: a versão anterior de ' + RelativePath +
        ' permanece em ' + SavedPath + '.');
    end;
  end;
end;

procedure RestoreBackup;
var
  RestoreFailed: Boolean;
begin
  RestoreFailed := False;
  RestoreOwnedComponent('build-info.json', RestoreFailed);
  RestoreOwnedComponent('native-host', RestoreFailed);
  RestoreOwnedComponent('onboarding', RestoreFailed);
  RestoreOwnedComponent('legal', RestoreFailed);
  RestoreOwnedComponent('licenses', RestoreFailed);
  RestoreOwnedComponent('host', RestoreFailed);
  RestoreOwnedComponent('Extension', RestoreFailed);

  if not RestoreFailed then
  begin
    if DirExists(BackupRoot) and
      (not DelTree(BackupRoot, True, True, True)) then
      Log('Rollback concluído, mas a pasta vazia de backup permaneceu em ' +
        BackupRoot + '.')
    else
      BackupOwned := False;
  end
  else
    Log('Rollback incompleto; preserve o backup para recuperação: ' + BackupRoot);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    InstallSucceeded := True;
    CleanupBackupCopy;
  end;
end;

procedure DeinitializeSetup;
begin
  if BackupOwned then
  begin
    if PayloadInstallStarted and (not InstallSucceeded) then
      RestoreBackup
    else
      CleanupBackupCopy;
  end;
end;
