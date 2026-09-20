; OpenMyModel Windows installer (Inno Setup 6).
; Payload paths and metadata are injected by scripts/make_installer.py via /D defines.

#ifndef Payload
#define Payload "payload"
#endif
#ifndef OutDir
#define OutDir "."
#endif
#ifndef Rev
#define Rev "dev"
#endif
#ifndef EngineTag
#define EngineTag "b10909"
#endif

[Setup]
AppId={{0E7DCCBC-284E-4B53-9157-A5A000C52279}
AppName=OpenMyModel
AppVersion=1.0.0
AppVerName=OpenMyModel 1.0.0 (llama.cpp {#EngineTag}, rev {#Rev})
AppPublisher=OpenMyModel
DefaultDirName={localappdata}\Programs\OpenMyModel
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
CloseApplications=yes
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
OutputDir={#OutDir}
OutputBaseFilename=OpenMyModel-Setup-1.0.0-{#Rev}
SetupIconFile=..\frontend\windows\runner\resources\app_icon.ico
UninstallDisplayIcon={app}\openmymodel.exe
WizardStyle=modern
ChangesEnvironment=no

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\OpenMyModel\OpenMyModel"; Filename: "{app}\openmymodel.exe"
Name: "{autodesktop}\OpenMyModel"; Filename: "{app}\openmymodel.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\openmymodel.exe"; Description: "{cm:LaunchProgram,OpenMyModel}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 安装目录内的运行残留（如有）随卸载删除；用户数据不受影响：
; 配置档案在 %USERPROFILE%\.openmymodel，偏好在 %APPDATA%，均不在安装目录内。
Type: filesandordirs; Name: "{app}\data"
