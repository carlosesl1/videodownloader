#ifndef ReleaseVersion
  #error ReleaseVersion must be provided by scripts/build-v1-release.ps1
#endif

#ifndef PayloadRoot
  #error PayloadRoot must be provided by scripts/build-v1-release.ps1
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
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
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
CloseApplications=no
RestartIfNeededByRun=no
UsePreviousAppDir=yes

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "{#PayloadRoot}\Extension\*"; DestDir: "{app}\Extension"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\host\*"; DestDir: "{app}\host"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\legal\*"; DestDir: "{app}\legal"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\onboarding\*"; DestDir: "{app}\onboarding"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\build-info.json"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{app}\native-host"

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
function JsonEscape(const Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
end;

procedure WriteNativeManifest;
var
  ManifestPath: String;
  HostPath: String;
  Lines: TArrayOfString;
begin
  HostPath := ExpandConstant('{app}\host\video-radar-host.exe');
  ManifestPath := ExpandConstant('{app}\native-host\{#NativeHostName}.json');
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

procedure VerifyNativeHost;
var
  HostPath: String;
  ResultCode: Integer;
begin
  HostPath := ExpandConstant('{app}\host\video-radar-host.exe');
  if not Exec(HostPath, '--ping', ExpandConstant('{app}\host'), SW_HIDE,
    ewWaitUntilTerminated, ResultCode) then
  begin
    RaiseException('O auxiliar local não pôde ser iniciado: ' +
      SysErrorMessage(ResultCode));
  end;
  if ResultCode <> 0 then
    RaiseException('O diagnóstico do auxiliar local falhou. Código: ' +
      IntToStr(ResultCode));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteNativeManifest;
    VerifyNativeHost;
  end;
end;
