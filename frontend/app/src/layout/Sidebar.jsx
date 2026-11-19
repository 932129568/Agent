/* B0 真实结构迁移：由 frontend/app/tools/gen-layout.mjs 从
 * frontend/react/src/generated/Sidebar.jsx 投影，已剥离 3 处事件桥。
 * AUTO-GENERATED — 请勿手改；改 R67 源后重跑本脚本。
 * 规范：React 唯一 DOM 所有者、零业务状态、零后端调用、零原生 DOM API。 */
export default function Sidebar() {
  return (
    <aside data-area="sidebar" className="sidebar" id="sidebar">
      <div className="sidebar-brand">
        <div className="brand-logo">
          G
        </div>
        <div style={{minWidth: "0"}}>
          <div className="brand-name">
            Harbor
          </div>
          <div className="brand-sub" id="brandModel">
            glm-4.5-flash
          </div>
        </div>
      </div>
      <div className="sidebar-header">
        <button className="new-chat-btn" id="new-chat-btn">
          <svg className="ui-icon">
            <use href="#i-plus" />
          </svg>
          新建对话
        </button>
        <div className="side-actions">
          <button className="ghost-btn" title="搜索全部会话">
            <svg className="ui-icon">
              <use href="#i-search" />
            </svg>
            搜索
          </button>
          <button className="ghost-btn">
            <svg className="ui-icon">
              <use href="#i-download" />
            </svg>
            导出
          </button>
        </div>
      </div>
      <div className="sidebar-history" id="sidebarHistory" aria-label="历史会话" />
      <div className="side-note">
        
    会话与配置仅保存在本机；文件与命令操作受工作区范围及安全护栏约束。
  
      </div>
      <div className="token-stat" id="tokenStat" />
    </aside>
  )
}
