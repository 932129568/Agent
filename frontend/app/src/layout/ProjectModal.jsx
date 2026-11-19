/* B0 真实结构迁移：由 frontend/app/tools/gen-layout.mjs 从
 * frontend/react/src/generated/ProjectModal.jsx 投影，已剥离 0 处事件桥。
 * AUTO-GENERATED — 请勿手改；改 R67 源后重跑本脚本。
 * 规范：React 唯一 DOM 所有者、零业务状态、零后端调用、零原生 DOM API。 */
export default function ProjectModal() {
  return (
    <div data-area="project-modal" className="project-modal" id="projectModal" role="dialog" aria-modal="true" aria-labelledby="projectModalTitle" aria-hidden="true" hidden={true}>
      <div className="project-dialog">
        <header className="project-dialog-head">
          <div>
            <h2 id="projectModalTitle">
              新建项目
            </h2>
            <p>
              项目会绑定一个专属工作文件夹，项目内新对话复用同一空间。
            </p>
          </div>
          <button type="button" className="expert-btn" id="projectCancelBtn" aria-label="取消新建项目">
            取消
          </button>
        </header>
        <label className="project-field" htmlFor="projectNameInput">
          <span>
            项目名称
          </span>
          <input id="projectNameInput" type="text" maxLength="60" placeholder="例如：Harbor 发布计划" autoComplete="off" />
        </label>
        <label className="project-field" htmlFor="projectWorkspaceInput">
          <span>
            工作文件夹
          </span>
          <div className="project-path-row">
            <input id="projectWorkspaceInput" type="text" placeholder="选择或输入项目专属文件夹路径" autoComplete="off" spellCheck="false" />
            <button type="button" className="expert-btn" id="projectBrowseBtn">
              选择文件夹
            </button>
          </div>
        </label>
        <p className="project-error" id="projectError" aria-live="polite" />
        <footer className="project-dialog-actions">
          <button type="button" className="expert-btn expert-btn-primary" id="projectCreateBtn">
            创建项目并开始对话
          </button>
        </footer>
      </div>
    </div>
  )
}
