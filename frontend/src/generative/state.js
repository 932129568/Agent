/* G4 transient projection state owned by AppState.uiGenerative, never a second store. */
function uiGenerativeStore() {
  const store = typeof AppState !== 'undefined' ? AppState.uiGenerative :
    (typeof uiGenerative !== 'undefined' ? uiGenerative : null);
  if (!store) return { views: {} };
  if (!store.views || typeof store.views !== 'object') store.views = {};
  if (!store.toolResults || typeof store.toolResults !== 'object') store.toolResults = {};
  if (!Number.isInteger(store.toolRevision)) store.toolRevision = 0;
  return store;
}
function uiGenerativeAttr(element, name) {
  return element && element.getAttribute ? element.getAttribute(name) : null;
}
function uiGenerativeEntities(root) {
  return root && root.querySelectorAll ? [...root.querySelectorAll('[data-entity-id]')] : [];
}
function uiGenerativeEntityState(element) {
  return {
    selected: uiGenerativeAttr(element, 'data-selected') === 'true',
    expanded: uiGenerativeAttr(element, 'data-expanded') === 'true',
    focusKey: uiGenerativeAttr(element, 'data-focus-key') || '',
  };
}
function uiGenerativeViewOwner(spec) {
  return { runId: spec.runId || '', sessionId: spec.sessionId || '', generation: spec.generation || 0 };
}
function uiGenerativeIsTransientSpec(spec) {
  return !!(spec && spec.blocks && spec.blocks.length === 1 &&
    spec.blocks[0].blockId === 'generation-skeleton' && spec.blocks[0].component === 'Skeleton');
}
const UiGenerativeState = Object.freeze({
  capture(projection) {
    const spec = projection.current;
    const root = projection.root;
    if (!spec || !root) return null;
    if (uiGenerativeIsTransientSpec(spec)) return uiGenerativeStore().views[spec.specId] || null;
    const view = Object.assign({ specId: spec.specId, revision: spec.revision,
      entities: {}, scroll: Number(root.scrollTop) || 0, focusKey: '', hadFocus: false,
      tableScroll: {}, transient: false }, uiGenerativeViewOwner(spec));
    const active = projection.document.activeElement;
    view.hadFocus = !!(active && root.contains && root.contains(active));
    if (view.hadFocus) view.focusKey = uiGenerativeAttr(active, 'data-focus-key') || '';
    uiGenerativeEntities(root).forEach(element => {
      const entityId = uiGenerativeAttr(element, 'data-entity-id');
      const block = element.closest ? element.closest('[data-block-id]') : null;
      const blockId = uiGenerativeAttr(block, 'data-block-id') || '';
      if (entityId) view.entities[blockId + '/' + entityId] = uiGenerativeEntityState(element);
    });
    if (root.querySelectorAll) {
      root.querySelectorAll('.ui-table-wrap').forEach((table, index) => {
        const key = uiGenerativeAttr(table, 'data-scroll-key') || String(index);
        view.tableScroll[key] = Number(table.scrollTop) || 0;
      });
    }
    return view;
  },
  save(view) {
    if (!view || !view.specId) return;
    const store = uiGenerativeStore();
    const existing = store.views[view.specId];
    if (view.transient && existing && !existing.transient) {
      store.views[view.specId] = Object.assign({}, existing, { revision: view.revision });
      return;
    }
    store.views[view.specId] = view;
  },
  restore(projection, previous) {
    const spec = projection.current;
    const root = projection.root;
    if (!spec || !root) return;
    const store = uiGenerativeStore();
    const saved = (previous && !previous.transient ? previous : store.views[spec.specId]) ||
      store.views[spec.specId];
    if (!saved || saved.specId !== spec.specId ||
        saved.runId !== (spec.runId || '') || saved.sessionId !== (spec.sessionId || '') ||
        saved.generation !== (spec.generation || 0)) return;
    const transientSkeleton = uiGenerativeIsTransientSpec(spec);
    if (transientSkeleton) {
      store.views[spec.specId] = Object.assign({}, saved, { revision: spec.revision },
        uiGenerativeViewOwner(spec));
      return;
    }
    const currentEntities = uiGenerativeEntities(root);
    const present = new Set();
    currentEntities.forEach(element => {
      const entityId = uiGenerativeAttr(element, 'data-entity-id');
      const block = element.closest ? element.closest('[data-block-id]') : null;
      const blockId = uiGenerativeAttr(block, 'data-block-id') || '';
      const key = blockId + '/' + entityId;
      present.add(key);
      const old = saved.entities && saved.entities[key];
      if (!old) return;
      element.setAttribute('data-selected', old.selected ? 'true' : 'false');
      element.setAttribute('data-expanded', old.expanded ? 'true' : 'false');
      element.setAttribute('aria-selected', old.selected ? 'true' : 'false');
      element.setAttribute('aria-expanded', old.expanded ? 'true' : 'false');
    });
    if (saved.entities) Object.keys(saved.entities).forEach(key => {
      if (!present.has(key)) delete saved.entities[key];
    });
    root.scrollTop = saved.scroll || 0;
    if (root.querySelectorAll) {
      root.querySelectorAll('.ui-table-wrap').forEach((table, index) => {
        const key = uiGenerativeAttr(table, 'data-scroll-key') || String(index);
        if (saved.tableScroll && saved.tableScroll[key] !== undefined) table.scrollTop = saved.tableScroll[key];
      });
    }
    if (saved.hadFocus) {
      let target = null;
      if (saved.focusKey && root.querySelectorAll) {
        target = [...root.querySelectorAll('[data-focus-key]')].find(element =>
          uiGenerativeAttr(element, 'data-focus-key') === saved.focusKey) || null;
      }
      if (!target && root.querySelector) target = root.querySelector('.ui-projection-title');
      if (target && target.focus) {
        try { target.focus({ preventScroll: true }); } catch (error) { target.focus(); }
      }
    }
    const next = Object.assign({}, saved, { specId: spec.specId, revision: spec.revision,
      entities: saved.entities || {} }, uiGenerativeViewOwner(spec));
    store.views[spec.specId] = next;
  },
  bind(projection) {
    const root = projection.root;
    if (!root || root.__uiGenerativeBound || !root.addEventListener) return;
    root.__uiGenerativeBound = true;
    const entityFromEvent = event => {
      let element = event.target;
      if (element && element.closest) return element.closest('[data-entity-id]');
      while (element && element !== root) {
        if (uiGenerativeAttr(element, 'data-entity-id')) return element;
        element = element.parentNode;
      }
      return null;
    };
    const toggle = (element, property) => {
      if (!element) return;
      const next = uiGenerativeAttr(element, property) !== 'true';
      element.setAttribute(property, next ? 'true' : 'false');
      element.setAttribute(property === 'data-selected' ? 'aria-selected' : 'aria-expanded', next ? 'true' : 'false');
      const view = UiGenerativeState.capture(projection);
      UiGenerativeState.save(view);
    };
    root.addEventListener('click', event => {
      const target = event.target;
      if (target && target.closest && target.closest('button,a,input,select,textarea')) return;
      toggle(entityFromEvent(event), 'data-selected');
    });
    root.addEventListener('keydown', event => {
      const element = entityFromEvent(event);
      if (!element) return;
      if (event.key === 'Enter') { event.preventDefault(); toggle(element, 'data-expanded'); }
      else if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault(); toggle(element, 'data-selected');
      }
    });
  },
});
