/* B0 真实结构迁移：由 frontend/app/tools/gen-layout.mjs 从
 * frontend/react/src/generated/HubMarket.jsx 投影，已剥离 0 处事件桥。
 * AUTO-GENERATED — 请勿手改；改 R67 源后重跑本脚本。
 * 规范：React 唯一 DOM 所有者、零业务状态、零后端调用、零原生 DOM API。 */
export default function HubMarket() {
  return (
    <div data-area="hub-market" className="hm-overlay" id="hubMarket" hidden={true} role="dialog" aria-modal="true" aria-labelledby="hmTitle">
      <div className="hm-shell">
        <header className="hm-head">
          <div className="hm-brand">
            <svg className="ui-icon ui-icon-20" aria-hidden="true">
              <use href="#i-market" />
            </svg>
            <h2 id="hmTitle">
              功能市场
            </h2>
          </div>
          <nav className="hm-tabs" id="hmTabs" aria-label="功能分类">
            <button type="button" className="on" data-hm-tab="expert">
              专家
            </button>
            <button type="button" data-hm-tab="skill">
              技能
            </button>
            <button type="button" data-hm-tab="connector">
              连接器
            </button>
          </nav>
          <div className="hm-head-right">
            <label className="hm-search">
              <svg className="ui-icon ui-icon-16" aria-hidden="true">
                <use href="#i-search" />
              </svg>
              <input id="hmSearch" type="search" placeholder="搜索专家 / 技能 / 连接器" aria-label="搜索功能市场" />
            </label>
            <button type="button" className="hm-mine" id="hmMine">
              我的功能 
              <span id="hmMineCount">
                0
              </span>
            </button>
            <button type="button" className="hm-close" id="hmClose" aria-label="关闭">
              ✕
            </button>
          </div>
        </header>
        <section className="hm-hot" id="hmHot" aria-label="分区热门" />
        <div className="hm-filter-row">
          <div className="hm-cats" id="hmCats" aria-label="分区筛选" />
          <div className="hm-sorts" id="hmSorts" aria-label="排序">
            <button type="button" className="on" data-hm-sort="综合">
              综合
            </button>
            <button type="button" data-hm-sort="最热">
              最热
            </button>
            <button type="button" data-hm-sort="最新">
              最新
            </button>
          </div>
        </div>
        <div className="hm-subrow">
          <div className="hm-subtabs" id="hmSubtabs" />
          <span className="hm-tip">
            启用后会出现在会话页「+」菜单里
          </span>
        </div>
        <div className="hm-conn-note" id="hmLinkStat" hidden={true} />
        <div className="hm-grid" id="hmGrid" />
        <footer className="hm-foot" id="hmFoot" />
      </div>
    </div>
  )
}
