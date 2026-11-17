Unicode True
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

!ifndef PRODUCT_VERSION
  !error "Build through scripts/Build-Installer.ps1."
!endif

Name "EZ Bench ${PRODUCT_VERSION}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\EZ Bench"
RequestExecutionLevel user
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 32
SetDatablockOptimize on
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "EZ Bench"
VIAddVersionKey /LANG=1033 "FileDescription" "EZ Bench per-user setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright 2026 EZ Bench contributors"
!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_NOAUTOCLOSE
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${APP_LICENSE}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var TestMode
Var Params

Function .onInit
  SetShellVarContext current
  ${IfNot} ${AtLeastWin10}
  ${OrIfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "EZ Bench requires Windows 10 or later (64-bit x64)." /SD IDOK
    SetErrorLevel 10
    Abort
  ${EndIf}
  StrCpy $TestMode 0
  ${GetParameters} $Params
  ClearErrors
  ${GetOptions} $Params "/UPDATEPID=" $0
  ${IfNot} ${Errors}
    ; Wait for the exact requesting process; never terminate a running app.
    System::Call 'kernel32::OpenProcess(i 0x100000, i 0, i r0) p.r1'
    ${If} $1 != 0
      System::Call 'kernel32::WaitForSingleObject(p r1, i 120000) i.r2'
      System::Call 'kernel32::CloseHandle(p r1)'
      ${If} $2 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "EZ Bench is still open. Finish your work, close it, then run this installer again." /SD IDOK
        SetErrorLevel 11
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${GetOptions} $Params "/TESTMODE" $0
  ${IfNot} ${Errors}
    StrCpy $TestMode 1
  ${EndIf}
  ${If} $TestMode == 0
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EZBench" "InstallLocation"
    ${If} $0 != ""
      StrCpy $INSTDIR $0
    ${EndIf}
    FindWindow $0 "" "EZ Bench"
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "Close EZ Bench before installing an update. Your databases and application data will be kept." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Function CheckInstallDirectory
  GetFullPathName $INSTDIR $INSTDIR
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$PROFILE"
  ${OrIf} $INSTDIR == "$APPDATA"
  ${OrIf} $INSTDIR == "$LOCALAPPDATA"
  ${OrIf} $INSTDIR == "$PROGRAMFILES"
  ${OrIf} $INSTDIR == "$WINDIR"
    MessageBox MB_OK|MB_ICONSTOP "Choose a dedicated EZ Bench installation folder." /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
  IfFileExists "$INSTDIR\.ez-bench-install.ini" owned check_empty
  owned:
    ReadINIStr $0 "$INSTDIR\.ez-bench-install.ini" "install" "product"
    ReadINIStr $1 "$INSTDIR\.ez-bench-install.ini" "install" "path"
    ${If} $0 != "EZ Bench"
    ${OrIf} $1 != "$INSTDIR"
      MessageBox MB_OK|MB_ICONSTOP "This folder has an invalid installation marker. Choose a new folder." /SD IDOK
      SetErrorLevel 4
      Abort
    ${EndIf}
    Return
  check_empty:
    IfFileExists "$INSTDIR\*.*" nonempty safe
  nonempty:
    MessageBox MB_OK|MB_ICONSTOP "This folder already contains files and is not an owned EZ Bench installation. Choose an empty folder." /SD IDOK
    SetErrorLevel 5
    Abort
  safe:
FunctionEnd

Section "EZ Bench" MainSection
  Call CheckInstallDirectory
  SetOutPath "$INSTDIR"
  !include "${PAYLOAD_INCLUDE}"
  SetOutPath "$INSTDIR"
  File /oname=.ez-bench-files.json "${FILES_MANIFEST}"
  WriteINIStr "$INSTDIR\.ez-bench-install.ini" "install" "product" "EZ Bench"
  WriteINIStr "$INSTDIR\.ez-bench-install.ini" "install" "path" "$INSTDIR"
  WriteINIStr "$INSTDIR\.ez-bench-install.ini" "install" "version" "${PRODUCT_VERSION}"
  WriteINIStr "$INSTDIR\.ez-bench-install.ini" "install" "testMode" "$TestMode"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ${If} $TestMode == 0
    CreateDirectory "$SMPROGRAMS\EZ Bench"
    CreateShortcut "$SMPROGRAMS\EZ Bench\EZ Bench.lnk" "$INSTDIR\EZ Bench.exe" "" "$INSTDIR\EZ Bench.exe" 0
    CreateShortcut "$SMPROGRAMS\EZ Bench\Uninstall EZ Bench.lnk" "$INSTDIR\Uninstall.exe"
    CreateShortcut "$DESKTOP\EZ Bench.lnk" "$INSTDIR\EZ Bench.exe" "" "$INSTDIR\EZ Bench.exe" 0
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EZBench" "DisplayName" "EZ Bench"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EZBench" "DisplayVersion" "${PRODUCT_VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EZBench" "DisplayIcon" "$INSTDIR\EZ Bench.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EZBench" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EZBench" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EZBench" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EZBench" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EZBench" "NoRepair" 1
  ${EndIf}
SectionEnd

Function un.onInit
  SetShellVarContext current
  GetFullPathName $INSTDIR $INSTDIR
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$PROFILE"
  ${OrIf} $INSTDIR == "$APPDATA"
  ${OrIf} $INSTDIR == "$LOCALAPPDATA"
  ${OrIf} $INSTDIR == "$PROGRAMFILES"
  ${OrIf} $INSTDIR == "$WINDIR"
    MessageBox MB_OK|MB_ICONSTOP "This is not a dedicated installation folder. No files were removed." /SD IDOK
    SetErrorLevel 6
    Abort
  ${EndIf}
  ReadINIStr $0 "$INSTDIR\.ez-bench-install.ini" "install" "product"
  ReadINIStr $1 "$INSTDIR\.ez-bench-install.ini" "install" "path"
  ReadINIStr $TestMode "$INSTDIR\.ez-bench-install.ini" "install" "testMode"
  ${If} $0 != "EZ Bench"
  ${OrIf} $1 != "$INSTDIR"
    MessageBox MB_OK|MB_ICONSTOP "The owned installation marker is missing or does not match this folder. No files were removed." /SD IDOK
    SetErrorLevel 6
    Abort
  ${EndIf}
  ${If} $TestMode != 1
    FindWindow $0 "" "EZ Bench"
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "Close EZ Bench before uninstalling. Your application data and databases will be kept." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Uninstall"
  ; Delete only build-owned file paths. Unknown user files are never removed.
  !include "${UNINSTALL_INCLUDE}"
  Delete "$INSTDIR\.ez-bench-files.json"
  Delete "$INSTDIR\.ez-bench-install.ini"
  Delete "$INSTDIR\Uninstall.exe"
  ${If} $TestMode != 1
    Delete "$SMPROGRAMS\EZ Bench\EZ Bench.lnk"
    Delete "$SMPROGRAMS\EZ Bench\Uninstall EZ Bench.lnk"
    RMDir "$SMPROGRAMS\EZ Bench"
    Delete "$DESKTOP\EZ Bench.lnk"
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EZBench" "InstallLocation"
    ${If} $0 == "$INSTDIR"
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EZBench"
    ${EndIf}
  ${EndIf}
  ; No recursive delete, AppData removal, database removal, reboot, or service action.
  RMDir "$INSTDIR"
SectionEnd
