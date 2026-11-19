/* B0 真实结构迁移：由 frontend/app/tools/gen-layout.mjs 从
 * frontend/react/src/generated/ExpertCenter.jsx 投影，已剥离 0 处事件桥。
 * AUTO-GENERATED — 请勿手改；改 R67 源后重跑本脚本。
 * 规范：React 唯一 DOM 所有者、零业务状态、零后端调用、零原生 DOM API。 */
export default function ExpertCenter() {
  return (
    <div data-area="expert-center" className="expert-overlay" id="expertCenter" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="expertCenterTitle" hidden={true}>
      <div className="expert-dialog">
        <header className="expert-dialog-head">
          <div>
            <h2 id="expertCenterTitle">
              功能市场
            </h2>
            <p>
              浏览 · 启用 · 停用（旧目录导入面板保留为兼容面）
            </p>
          </div>
          <button type="button" className="expert-btn" id="expertCloseBtn">
            关闭
          </button>
        </header>
        <p className="expert-center-status" id="expertCenterStatus" aria-live="polite" />
        <div className="expert-import-row">
          <input id="expertImportPath" type="text" aria-label="专家包目录路径" placeholder="已存在的专家包目录（不支持 zip）" />
          <button type="button" className="expert-btn" id="expertImportBtn">
            导入目录
          </button>
        </div>
        <input id="expertSearch" type="search" aria-label="搜索专家包" placeholder="搜索专家包" />
        <div className="expert-layout">
          <div className="expert-package-list" id="expertPackageList" aria-label="专家包列表" />
          <article className="expert-package-detail" id="expertPackageDetail" aria-label="专家包详情" />
        </div>
        <footer className="expert-dialog-actions">
          <button type="button" className="expert-btn" id="expertEnableBtn" disabled={true}>
            启停
          </button>
          <button type="button" className="expert-btn expert-btn-primary" id="expertSelectBtn" disabled={true}>
            选择此专家（发送时自动加载）
          </button>
        </footer>
      </div>
    </div>
  )
}
