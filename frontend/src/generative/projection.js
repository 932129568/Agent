/* Native UiSpec projection. Only complete validated objects are committed. */
class UiProjectionSession {
  constructor(host, options) {
    this.host = host;
    this.document = host.ownerDocument || document;
    this.options = options || {};
    this.metrics = Object.create(null);
    this.bindings = Object.create(null);
    this.current = null;
    this.owner = null;
    this.root = null;
    this.lastResult = null;
  }
  createElement(tag, className, text) {
    const element = this.document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }
  createElementNS(namespace, tag, className, text) {
    const element = this.document.createElementNS(namespace, tag);
    if (className) element.setAttribute('class', className);
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }
  mount(spec) {
    this.host.replaceChildren();
    this.root = this.createElement('section', 'ui-projection');
    this.root.setAttribute('aria-label', '生成视图');
    this.host.appendChild(this.root);
    if (typeof UiGenerativeState !== 'undefined') UiGenerativeState.bind(this);
    this.commit(spec);
    return this;
  }
  context(blockId) {
    return {
      blockId: blockId || '',
      createElement: (tag, className, text) => this.createElement(tag, className, text),
      createElementNS: (namespace, tag, className, text) =>
        this.createElementNS(namespace, tag, className, text),
      metrics: this.metrics,
    };
  }
  fallback(code) {
    this.metrics[code] = (this.metrics[code] || 0) + 1;
    if (this.current) return { ok: false, error: code };
    const rendered = UiComponentRegistry.render({
      component: 'EmptyState',
      props: { title: '视图暂时无法显示', body: '请稍后重试或返回原始视图。' },
    }, this.context());
    this.root.replaceChildren(rendered.element);
    this.root.setAttribute('data-fallback', code);
    return { ok: false, error: code };
  }
  resolveBlock(block) {
    let resolvedBlock = block;
    if (block.bind) {
      const resolved = DataRefResolver.resolve(block.bind, this.options.dataRefHost, block.component);
      if (!resolved.ok) {
        const code = resolved.code || 'not_found';
        const metric = code === 'not_found' ? 'binding.miss' : 'binding.' + code;
        this.metrics[metric] = (this.metrics[metric] || 0) + 1;
        resolvedBlock = Object.assign({}, block, {
          component: 'EmptyState',
          props: { title: '无法显示绑定数据', body: code === 'forbidden'
            ? '没有权限查看此数据。' : '数据暂不可用，请刷新后重试。' },
          bind: undefined,
        });
      } else {
        const injected = DataRefResolver.inject(block, resolved);
        if (!injected.ok) {
          this.metrics['binding.type_mismatch'] = (this.metrics['binding.type_mismatch'] || 0) + 1;
          resolvedBlock = Object.assign({}, block, {
            component: 'EmptyState',
            props: { title: '无法显示绑定数据', body: '数据格式暂不支持。' }, bind: undefined,
          });
        } else {
          this.bindings[block.blockId] = resolved;
          resolvedBlock = injected.block;
        }
      }
    }
    if (block.children && block.children.length) {
      resolvedBlock = Object.assign({}, resolvedBlock, {
        children: block.children.map(child => this.resolveBlock(child)),
      });
    }
    return resolvedBlock;
  }
  resolveSpec(spec) {
    this.bindings = Object.create(null);
    return Object.assign({}, spec, { blocks: spec.blocks.map(block => this.resolveBlock(block)) });
  }
  renderBlock(block) {
    const wrapper = this.createElement('article', 'ui-block');
    wrapper.setAttribute('data-block-id', block.blockId);
    const rendered = UiComponentRegistry.render(block, this.context(block.blockId));
    wrapper.appendChild(rendered.element);
    if (block.children && block.children.length) {
      const children = this.createElement('div', 'ui-block-children');
      block.children.forEach(child => children.appendChild(this.renderBlock(child)));
      wrapper.appendChild(children);
    }
    return wrapper;
  }
  render(spec, root) {
    const target = root || this.root;
    target.replaceChildren();
    target.removeAttribute('data-fallback');
    target.setAttribute('data-layout', spec.layout);
    target.setAttribute('data-revision', String(spec.revision));
    if (spec.title) {
      const title = this.createElement('h2', 'ui-projection-title', spec.title);
      title.setAttribute('data-focus-key', 'title');
      title.setAttribute('tabindex', '-1');
      target.appendChild(title);
    }
    const status = this.createElement('div', 'ui-sr-only', '已更新 ' + spec.blocks.length + ' 个区块');
    status.setAttribute('aria-live', 'polite');
    target.appendChild(status);
    const layout = this.createElement('div', 'ui-layout ui-layout-' + spec.layout);
    spec.blocks.forEach(block => layout.appendChild(this.renderBlock(block)));
    target.appendChild(layout);
    if (this.options.focusTitle && spec.title) {
      const title = target.querySelector('.ui-projection-title');
      if (title) {
        title.setAttribute('tabindex', '-1');
        title.focus();
      }
    }
  }
  commit(input) {
    const validated = validateUiSpec(input);
    if (!validated.ok) {
      this.lastResult = this.fallback('schema_reject');
      this.lastResult.validation = validated.error;
      return this.lastResult;
    }
    const spec = typeof UiGenerativeActions !== 'undefined'
      ? UiGenerativeActions.sanitize(validated.value, this.metrics) : validated.value;
    if (this.current) {
      const runId = spec.runId || this.owner.runId;
      const sessionId = spec.sessionId || this.owner.sessionId;
      const generation = spec.generation === undefined ? this.owner.generation : spec.generation;
      if (runId !== this.owner.runId || sessionId !== this.owner.sessionId ||
          generation !== this.owner.generation) {
        this.metrics.ignored_late_spec = (this.metrics.ignored_late_spec || 0) + 1;
        this.lastResult = { ok: false, error: 'stale_context', revision: this.current.revision };
        return this.lastResult;
      }
      if (spec.revision < this.current.revision) {
        this.metrics.ignored_late_spec = (this.metrics.ignored_late_spec || 0) + 1;
        this.lastResult = { ok: false, error: 'stale_revision', revision: this.current.revision };
        return this.lastResult;
      }
    } else {
      this.owner = {
        runId: this.options.runId || spec.runId || '',
        sessionId: this.options.sessionId || spec.sessionId || '',
        generation: this.options.generation === undefined
          ? (spec.generation || 0) : this.options.generation,
      };
    }
    const previousState = typeof UiGenerativeState !== 'undefined'
      ? UiGenerativeState.capture(this) : null;
    const previousRoot = this.root;
    const previousCurrent = this.current;
    const previousBindings = this.bindings;
    try {
      const resolvedSpec = this.resolveSpec(spec);
      const nextRoot = this.createElement('section', 'ui-projection');
      nextRoot.setAttribute('aria-label', '生成视图');
      this.render(resolvedSpec, nextRoot);
      const transaction = Object.create(this);
      transaction.root = nextRoot;
      transaction.current = spec;
      if (typeof UiGenerativeActions !== 'undefined') UiGenerativeActions.afterRender(transaction);
      this.host.replaceChildren(nextRoot);
      this.root = nextRoot;
      this.current = spec;
      if (typeof UiGenerativeState !== 'undefined') {
        UiGenerativeState.restore(this, previousState);
        UiGenerativeState.bind(this);
      }
    } catch (error) {
      this.root = previousRoot;
      this.current = previousCurrent;
      this.bindings = previousBindings;
      if (previousRoot) this.host.replaceChildren(previousRoot);
      if (previousState && typeof UiGenerativeState !== 'undefined') UiGenerativeState.save(previousState);
      throw error;
    }
    this.lastResult = { ok: true, revision: spec.revision, blocks: spec.blocks.length,
      bindings: Object.keys(this.bindings).length };
    return this.lastResult;
  }
}

const UiProjection = Object.freeze({
  mount(host, spec, options) {
    return new UiProjectionSession(host, options).mount(spec);
  },
  commit(session, spec) {
    return session.commit(spec);
  },
});
