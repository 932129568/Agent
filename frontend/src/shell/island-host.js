/* ================= 岛层宿主（框架无关桥） =================
 * 职责：在 legacy 页面里为「岛」提供挂载点与数据推流。
 *
 * 为什么不叫 vue-host：岛层框架是可替换实现（React/Vue/原生均可），
 * 本文件只依赖 `window.HarborIsland` 这一份挂载契约。换框架时只需要替换
 * prebuilt 产物，不再改动任何 legacy 业务代码。
 *
 * 设计约束：
 *   1. 单向数据流——legacy 仍是会话数据的 writer，岛只读渲染；
 *   2. 可开关——产物未加载时全部函数返回 false，调用方保持 legacy 行为；
 *   3. 幂等——重复挂载只做数据同步，不重复创建根节点。
 */

function harborIslandAvailable() {
  return typeof window !== 'undefined' && !!window.HarborIsland &&
    typeof window.HarborIsland.mount === 'function';
}

function harborIslandSidebarActive() {
  return typeof window !== 'undefined' && window.__HARBOR_ISLAND_SIDEBAR__ === true;
}

/** 把 legacy 会话/项目/当前选中推给岛（只读投影）。 */
function harborIslandSyncSidebar() {
  if (!harborIslandSidebarActive() || !harborIslandAvailable()) return false;
  try {
    window.HarborIsland.api.syncSessions(sessions, projects, currentSessionId);
    return true;
  } catch (e) {
    return false;
  }
}

/** 挂载会话侧栏岛到 #sidebarHistory；不可用时返回 false 由调用方回落 legacy 渲染。 */
function harborIslandMountSidebar() {
  if (typeof window === 'undefined' || !harborIslandAvailable()) return false;
  const host = document.getElementById('sidebarHistory');
  if (!host) return false;
  if (harborIslandSidebarActive()) return harborIslandSyncSidebar();
  try {
    window.HarborIsland.mount(host, {
      island: 'sidebar',
      autoLoad: false,
      onSelect: function (id) {
        try { if (typeof switchSession === 'function') switchSession(id); } catch (e) {}
      },
      onNewSessionInProject: function (project) {
        try {
          if (typeof createProjectSession === 'function') createProjectSession(project);
        } catch (e) {}
      },
    });
  } catch (e) {
    return false;
  }
  window.__HARBOR_ISLAND_SIDEBAR__ = true;
  return harborIslandSyncSidebar();
}
