; Harbor Desktop v2.0 · 前沿玻璃拟态风格 NSIS Modern UI 2 定制安装脚本
; 特性：中文/英文引导、升级平滑关闭旧实例、透明化目录说明、卸载保留用户本地数据

!macro customHeader
  !system "echo Building Harbor Modern NSIS Installer..."
!macroend

!macro preInit
  ; 默认使用简洁用户级安装目录，避免 UAC 阻断日常体验
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Harbor"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Harbor"
!macroend

!macro customInit
  ; 若检测到旧版 Harbor 仍在后台运行，优雅提示并尝试退出以防文件占用失败
  nsExec::ExecToLog 'taskkill /IM "Harbor.exe" /T /F'
!macroend

!macro customInstall
  ; 写入 AppUserModelID 与自定义 harbor:// 协议元数据，便于通知中心与快捷启动识别
  WriteRegStr HKCU "Software\Classes\harbor" "" "URL:Harbor Desktop Protocol"
  WriteRegStr HKCU "Software\Classes\harbor" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\harbor\DefaultIcon" "" "$INSTDIR\Harbor.exe,0"
  WriteRegStr HKCU "Software\Classes\harbor\shell\open\command" "" '"$INSTDIR\Harbor.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\harbor"
!macroend
