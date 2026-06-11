(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const viewMode = app?.dataset?.mode || 'panel';
  let board = null;
  let editorTask = null;
  let selectedTaskId = null;
  let draggedTaskId = null;
  let repositoryValidationMessage = '';
  let taskValidationMessage = '';
  let pendingPicker = '';
  let taskHelpOpen = false;
  const persistedState = vscode.getState?.() || {};
  let boardGroupMode = ['none', 'repository', 'runner'].includes(persistedState.boardGroupMode)
    ? persistedState.boardGroupMode
    : 'none';
  let collapsedTaskGroups = normalizeCollapsedState(persistedState.collapsedTaskGroups);
  let collapsedSidebarSections = normalizeCollapsedState(persistedState.collapsedSidebarSections);

  vscode.postMessage({ type: 'ready', payload: { mode: viewMode } });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      board = message.state;
      render();
    }
    if (message.type === 'openNewTask') {
      editorTask = createDraftTask();
      selectedTaskId = null;
      taskValidationMessage = '';
      taskHelpOpen = false;
      render();
    }
    if (message.type === 'selectTask') {
      selectedTaskId = message.taskId;
      editorTask = null;
      taskValidationMessage = '';
      taskHelpOpen = false;
      render();
    }
    if (message.type === 'repositoryPicked') {
      if (editorTask) {
        pendingPicker = '';
        editorTask.repository = message.payload.repository;
        board.repositoryBranches = board.repositoryBranches || {};
        board.repositoryBranches[message.payload.repository.path] = message.payload.branches || [];
        if (message.payload.runnerOptions?.length) {
          board.runnerOptions = message.payload.runnerOptions;
        }
        if (message.payload.repositoryDiscovery) {
          board.repositoryDiscovery = message.payload.repositoryDiscovery;
        }
        editorTask.branchBase = (message.payload.branches || []).find((branch) => branch.current)?.name || '';
        repositoryValidationMessage = '';
        normalizeRunnerSelections(editorTask, true);
        render();
      }
    }
    if (message.type === 'repositoryValidation') {
      pendingPicker = '';
      repositoryValidationMessage = message.payload?.message || '';
      render();
    }
    if (message.type === 'repositoryPickCancelled') {
      pendingPicker = '';
      render();
    }
    if (message.type === 'contextFilesPicked') {
      if (editorTask) {
        pendingPicker = '';
        editorTask.contextItems = [...(editorTask.contextItems || []), ...(message.payload || [])];
        render();
      }
    }
    if (message.type === 'contextPickCancelled') {
      pendingPicker = '';
      render();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && taskHelpOpen) {
      taskHelpOpen = false;
      render();
    }
  });

  function t(key) {
    return board?.messages?.[key] || key;
  }

  function renderSidebar() {
    const shell = el('main', 'sidebar-home');
    shell.append(renderSidebarIntro(), renderSidebarSummary(), renderProviderUsage(), renderSidebarActions(), renderSidebarRecent());
    return shell;
  }

  function renderSidebarIntro() {
    const intro = el('section', 'sidebar-intro');
    intro.innerHTML = `
      <div class="sigil" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <div>
        <h1>${escapeHtml(t('appTitle'))}</h1>
        <p>${escapeHtml(t('sidebarTagline'))}</p>
      </div>
    `;
    return intro;
  }

  function renderSidebarSummary() {
    const groups = taskGroups();
    const sectionId = 'summary';
    const contentId = 'sidebar-summary-content';
    const collapsed = isSidebarSectionCollapsed(sectionId);
    const summary = el('section', `sidebar-section collapsible-section${collapsed ? ' is-collapsed' : ''}`);
    summary.append(collapsibleSectionHead(t('summary'), board.queuePaused ? t('queuePaused') : t('queueActive'), collapsed, contentId, () => toggleSidebarSection(sectionId)));
    if (!collapsed) {
      const list = el('div', 'summary-list');
      list.id = contentId;
      list.innerHTML = `
        ${summaryRow(t('pending'), groups.pending.length, 'pending')}
        ${summaryRow(t('queued'), groups.queued.length, 'queued')}
        ${summaryRow(t('running'), groups.running.length, 'running')}
        ${summaryRow(t('failed'), groups.failed.length, 'failed')}
        ${summaryRow(t('completed'), groups.completed.length, 'completed')}
        ${summaryRow(t('queueMode'), queueModeLabel(), 'queue')}
        ${summaryRow(t('maxConcurrent'), String(board.queueMaxConcurrent || 1), 'queue')}
      `;
      summary.append(list);
    }
    return summary;
  }

  function renderSidebarActions() {
    const sectionId = 'configuration';
    const contentId = 'sidebar-configuration-content';
    const collapsed = isSidebarSectionCollapsed(sectionId);
    const actions = el('section', `sidebar-section collapsible-section${collapsed ? ' is-collapsed' : ''}`);
    actions.append(collapsibleSectionHead(t('configuration'), '', collapsed, contentId, () => toggleSidebarSection(sectionId)));
    if (collapsed) {
      return actions;
    }
    const primary = el('div', 'sidebar-actions primary-actions');
    primary.append(
      button(t('openBoard'), 'primary wide', () => post('openBoard')),
      button(t('newTask'), 'wide', () => post('openNewTaskPanel'))
    );

    const config = el('div', 'sidebar-actions config-actions');
    const setupRow = el('div', 'compact-action-row');
    setupRow.append(
      compactTextButton('Copilot', t('checkCopilot'), () => post('checkCopilot')),
      compactTextButton('Codex', t('checkCodex'), () => post('checkCodex')),
      compactTextButton('Claude', t('checkClaude'), () => post('checkClaude'))
    );
    const queueRow = el('div', 'compact-action-row');
    queueRow.append(
      compactTextButton('Settings', t('openSettings'), () => post('openSettings')),
      compactTextButton(board.queuePaused ? 'Resume' : 'Pause', board.queuePaused ? t('resumeQueue') : t('pauseQueue'), () => post(board.queuePaused ? 'resumeQueue' : 'pauseQueue')),
      compactTextButton(board.completedVisible ? 'Done off' : 'Done on', board.completedVisible ? t('hideCompleted') : t('showCompleted'), () => toggleCompletedVisibility())
    );
    config.append(
      button(`${t('queueMode')}: ${queueModeLabel()}`, 'wide queue-mode-button', () => toggleQueueExecutionMode()),
      setupRow,
      queueRow,
      button(t('cleanup'), 'danger wide', () => post('cleanupCompleted'))
    );

    const content = el('div', 'sidebar-section-content');
    content.id = contentId;
    content.append(primary, config);
    actions.append(content);
    return actions;
  }

  function renderProviderUsage() {
    const sectionId = 'providerUsage';
    const contentId = 'sidebar-provider-usage-content';
    const snapshots = providerUsageSnapshots();
    const collapsed = isSidebarSectionCollapsed(sectionId);
    const section = el('section', `sidebar-section provider-usage-section collapsible-section${collapsed ? ' is-collapsed' : ''}`);
    section.append(collapsibleSectionHead(t('providerUsage'), providerUsageMeta(snapshots), collapsed, contentId, () => toggleSidebarSection(sectionId)));
    if (collapsed) {
      return section;
    }
    const content = el('div', 'sidebar-section-content provider-usage-list');
    content.id = contentId;
    for (const snapshot of snapshots) {
      content.append(renderProviderUsageRow(snapshot));
    }
    const actions = el('div', 'provider-usage-actions');
    actions.append(compactTextButton(t('updateHealth'), t('updateHealth'), () => post('updateProviderHealth')));
    content.append(actions);
    section.append(content);
    return section;
  }

  function renderProviderUsageRow(snapshot) {
    const row = el('div', 'provider-usage-row');
    const provider = el('div', 'provider-usage-provider');
    provider.innerHTML = `
      <strong>${escapeHtml(providerLabel(snapshot.providerId))}</strong>
      <span>${escapeHtml(snapshot.label || statusLabel(snapshot.status))}</span>
    `;
    const badge = el('span', `usage-badge usage-${snapshot.status || 'unknown'}`, statusLabel(snapshot.status));
    badge.title = usageTooltip(snapshot);
    badge.setAttribute('aria-label', usageTooltip(snapshot));
    const action = providerUsageAction(snapshot.providerId);
    row.append(provider, badge, action);
    return row;
  }

  function providerUsageAction(providerId) {
    if (providerId === 'codex') {
      return compactTextButton('Check', t('checkUsage'), () => post('checkCodexUsage'));
    }
    if (providerId === 'claude') {
      return compactTextButton('Check', t('checkUsage'), () => post('checkClaudeUsage'));
    }
    return compactTextButton('Web', t('viewUsageWeb'), () => post('viewCopilotUsage'));
  }

  function renderSidebarRecent() {
    const recent = sortByActivity(board.tasks).slice(0, 5);
    const sectionId = 'recentWork';
    const contentId = 'sidebar-recent-work-content';
    const collapsed = isSidebarSectionCollapsed(sectionId);
    const section = el('section', `sidebar-section recent-section collapsible-section${collapsed ? ' is-collapsed' : ''}`);
    section.append(collapsibleSectionHead(t('recentWork'), String(recent.length), collapsed, contentId, () => toggleSidebarSection(sectionId)));
    if (collapsed) {
      return section;
    }
    const content = el('div', 'sidebar-section-content');
    content.id = contentId;
    if (recent.length === 0) {
      content.append(el('div', 'empty compact', t('noTasks')));
      section.append(content);
      return section;
    }
    const list = el('div', 'sidebar-task-list');
    for (const task of recent) {
      const row = el('button', 'sidebar-task');
      row.type = 'button';
      row.addEventListener('click', () => post('openTaskPanel', task.id));
      row.innerHTML = `
        <span class="task-title">${escapeHtml(task.title)}</span>
        <span class="task-meta">${escapeHtml(formatStatus(task.status))} / ${escapeHtml(task.runner?.id || 'runner')}</span>
      `;
      list.append(row);
    }
    content.append(list);
    section.append(content);
    return section;
  }

  function summaryRow(label, count, tone) {
    return `
      <div class="summary-row tone-${tone}">
        <span>${escapeHtml(label)}</span>
        <strong>${count}</strong>
      </div>
    `;
  }

  function taskGroups() {
    return {
      pending: board.tasks.filter((task) => task.status === 'pending'),
      queued: board.tasks.filter((task) => task.status === 'queued'),
      running: board.tasks.filter((task) => ['running', 'waiting_for_input', 'waiting_for_approval'].includes(task.status)),
      failed: board.tasks.filter((task) => task.status === 'failed'),
      completed: board.tasks.filter((task) => ['succeeded', 'cancelled', 'expired'].includes(task.status))
    };
  }

  function render() {
    if (!board) {
      return;
    }
    app.innerHTML = '';
    if (viewMode === 'sidebar') {
      app.append(renderSidebar());
      return;
    }
    app.append(renderHeader());
    if (editorTask) {
      app.append(renderEditor());
      return;
    }
    app.append(renderBoard());
    if (selectedTaskId) {
      const task = board.tasks.find((item) => item.id === selectedTaskId);
      if (task) {
        app.append(renderDetail(task));
      }
    }
  }

  function renderHeader() {
    const header = el('header', 'topbar');
    const brand = el('div', 'brand');
    brand.innerHTML = `
      <div class="sigil" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <div>
        <h1>${escapeHtml(t('appTitle'))}</h1>
        <p>${escapeHtml(t('tagline'))}</p>
      </div>
    `;

    const actions = el('div', 'toolbar');
    actions.append(renderBoardGroupControl());
    const queueActions = el('div', 'toolbar-cluster');
    queueActions.append(
      button(t('newTask'), 'primary', () => {
        editorTask = createDraftTask();
        selectedTaskId = null;
        taskValidationMessage = '';
        render();
      }),
      button(queueModeLabel(), 'queue-mode-button', () => toggleQueueExecutionMode()),
      button(t('runNext'), '', () => post('runNext')),
      compactButton(board.queuePaused ? t('resumeQueue') : t('pauseQueue'), board.queuePaused ? 'play' : 'pause', () => post(board.queuePaused ? 'resumeQueue' : 'pauseQueue'))
    );
    const healthActions = el('div', 'toolbar-cluster');
    healthActions.append(
      compactButton(t('checkCopilot'), 'shield', () => post('checkCopilot')),
      compactButton(t('checkCodex'), 'bot', () => post('checkCodex')),
      compactButton(t('checkClaude'), 'sparkle', () => post('checkClaude'))
    );
    const boardActions = el('div', 'toolbar-cluster');
    const cleanupButton = compactButton(t('cleanup'), 'trash', () => post('cleanupCompleted'));
    cleanupButton.classList.add('danger');
    boardActions.append(
      compactButton(board.completedVisible ? t('hideCompleted') : t('showCompleted'), 'eye', () => toggleCompletedVisibility()),
      compactButton(t('openDetachedBoard'), 'external', () => post('openDetachedBoard')),
      cleanupButton
    );
    actions.append(queueActions, healthActions, boardActions);

    header.append(brand, renderBoardProviderUsageStrip(), actions);
    return header;
  }

  function renderBoardProviderUsageStrip() {
    const strip = el('div', 'board-provider-strip');
    strip.setAttribute('aria-label', t('providerUsage'));
    for (const snapshot of providerUsageSnapshots()) {
      const chip = el('span', `board-provider-chip usage-${snapshot.status || 'unknown'}`);
      chip.title = usageTooltip(snapshot);
      chip.setAttribute('aria-label', usageTooltip(snapshot));
      chip.innerHTML = `
        <strong>${escapeHtml(providerLabel(snapshot.providerId))}</strong>
        <span>${escapeHtml(statusLabel(snapshot.status))}</span>
      `;
      strip.append(chip);
    }
    strip.append(compactButton(t('updateHealth'), 'pulse', () => post('updateProviderHealth')));
    return strip;
  }

  function renderBoardGroupControl() {
    const group = el('div', 'group-control');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', t('groupBy'));
    group.innerHTML = `<span>${escapeHtml(t('groupBy'))}</span>`;
    for (const [mode, label] of [
      ['none', t('groupNone')],
      ['repository', t('groupRepository')],
      ['runner', t('groupRunner')]
    ]) {
      const option = button(label, boardGroupMode === mode ? 'is-selected' : '', () => setBoardGroupMode(mode));
      option.setAttribute('aria-pressed', String(boardGroupMode === mode));
      group.append(option);
    }
    return group;
  }

  function renderBoard() {
    const boardEl = el('main', 'kanban');
    const columns = [
      ['pending', t('pending'), (task) => task.status === 'pending'],
      ['queued', t('queued'), (task) => task.status === 'queued'],
      ['running', t('running'), (task) => ['running', 'waiting_for_input', 'waiting_for_approval'].includes(task.status)],
      ['failed', t('failed'), (task) => task.status === 'failed'],
      ['completed', t('completed'), (task) => ['succeeded', 'cancelled', 'expired'].includes(task.status)]
    ];

    for (const [columnId, label, predicate] of columns) {
      if (columnId === 'completed' && !board.completedVisible) {
        continue;
      }
      boardEl.append(renderColumn(columnId, label, board.tasks.filter(predicate)));
    }
    return boardEl;
  }

  function renderColumn(columnId, label, tasks) {
    const column = el('section', `column column-${columnId}`);
    column.dataset.column = columnId;
    const head = el('div', 'column-head');
    head.innerHTML = `<h2>${escapeHtml(label)}</h2><span>${tasks.length}</span>`;
    column.append(head);

    const list = el('div', 'task-list');
    if (columnId === 'pending' || columnId === 'queued') {
      list.addEventListener('dragover', (event) => event.preventDefault());
      list.addEventListener('drop', (event) => handleColumnDrop(event, columnId, list));
    }

    const visibleTasks = columnId === 'queued' ? sortQueued(tasks) : sortByActivity(tasks);
    if (visibleTasks.length === 0) {
      list.append(el('div', 'empty', t(columnId === 'queued' ? 'queueEmpty' : 'noTasks')));
    } else if (boardGroupMode !== 'none') {
      for (const group of groupedTasks(visibleTasks, boardGroupMode)) {
        list.append(renderTaskGroup(group, columnId));
      }
    } else {
      for (const task of visibleTasks) {
        list.append(renderTaskCard(task, columnId));
      }
    }

    column.append(list);
    return column;
  }

  function renderTaskGroup(group, columnId) {
    const collapsed = isTaskGroupCollapsed(columnId, group.key);
    const contentId = `task-group-${slug(boardGroupMode)}-${slug(columnId)}-${slug(group.key)}`;
    const section = el('section', `task-group${collapsed ? ' is-collapsed' : ''}`);
    section.dataset.groupKey = group.key;
    section.append(collapsibleTaskGroupHead(group, columnId, collapsed, contentId));
    if (collapsed) {
      return section;
    }
    const tasks = el('div', 'task-group-list');
    tasks.id = contentId;
    for (const task of group.tasks) {
      tasks.append(renderTaskCard(task, columnId));
    }
    section.append(tasks);
    return section;
  }

  function renderTaskCard(task, columnId) {
    const run = latestRunForTask(task);
    const active = isActiveStatus(task.status);
    const card = el('article', `task-card priority-${task.priority} status-${statusClass(task.status)}${active ? ' is-agent-active' : ''}`);
    card.dataset.taskId = task.id;
    card.dataset.column = columnId;
    card.draggable = columnId === 'pending' || columnId === 'queued' || columnId === 'failed';
    card.addEventListener('click', () => {
      selectedTaskId = task.id;
      editorTask = null;
      render();
    });
    card.addEventListener('dragstart', () => {
      draggedTaskId = task.id;
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      draggedTaskId = null;
      card.classList.remove('dragging');
    });

    const meta = [
      task.repository?.label || 'repo',
      task.branchBase || currentBranchName() || 'branch',
      task.runner?.id || 'runner',
      task.model?.label || 'model',
      task.isolationMode || 'workspace',
      permissionLabel(task.permissionProfile) || 'permissions'
    ];
    const providerUsage = taskProviderUsage(task);
    card.innerHTML = `
      <div class="card-leds"><i></i><i></i><i></i></div>
      ${active ? agentActivityMarkup(task) : ''}
      <h3>${escapeHtml(task.title)}</h3>
      <p>${escapeHtml(shorten(task.spec, 120))}</p>
      <div class="meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
      <div class="card-foot">
        <span class="priority">${escapeHtml(task.priority)}</span>
        <span>${escapeHtml(formatStatus(task.status))}</span>
        ${providerUsage ? providerUsageChipMarkup(providerUsage) : ''}
        ${run?.changedFiles?.length ? `<span>${escapeHtml(String(run.changedFiles.length))} files</span>` : ''}
      </div>
    `;

    const actions = el('div', 'card-actions');
    if (task.status === 'pending') {
      actions.append(iconButton(t('enqueue'), 'queue', () => post('enqueueTask', task.id)));
      actions.append(iconButton(t('runNow'), 'play', () => post('runTask', task.id)));
    }
    if (task.status === 'queued') {
      actions.append(iconButton(t('runNow'), 'play', () => post('runTask', task.id)));
    }
    if (task.status === 'failed') {
      actions.append(iconButton(t('requeue'), 'queue', () => post('enqueueTask', task.id)));
    }
    if (task.repository?.path) {
      actions.append(iconButton(t('openRepository'), 'folder', () => post('openRepository', task.repository.path)));
    }
    actions.append(iconButton(t('duplicate'), 'copy', () => post('duplicateTask', task.id)));
    actions.append(iconButton(t('delete'), 'trash', () => post('deleteTask', task.id)));
    card.append(actions);
    return card;
  }

  function agentActivityMarkup(task) {
    const label = task.status === 'waiting_for_approval'
      ? 'approval needed'
      : task.status === 'waiting_for_input'
        ? 'waiting for input'
        : 'agent running';
    return `
      <div class="agent-activity" aria-label="${escapeAttribute(label)}">
        <span class="agent-orbit" aria-hidden="true"><i></i><i></i><i></i></span>
        <strong>${escapeHtml(label)}</strong>
      </div>
      <div class="agent-pulse-rail" aria-hidden="true"><i></i></div>
    `;
  }

  function renderEditor() {
    const shell = el('main', 'session-editor editor');
    const task = editorTask;
    normalizeRunnerSelections(task);
    const repoLabel = task.repository?.label || task.repository?.path || 'Select repository';
    const runner = runnerOptionFor(task.runner?.id);
    const branchLabel = task.branchBase || 'Branch';
    shell.innerHTML = `
      <div class="session-head">
        <div>
          <h2>${escapeHtml(task.id ? 'Edit task session' : 'New session')}</h2>
          <p>
            <span>${escapeHtml(repoLabel)}</span>
            <i>/</i>
            <span>${escapeHtml(runner.label)}</span>
            <i>/</i>
            <span>${escapeHtml(branchLabel)}</span>
          </p>
        </div>
      </div>
    `;
    const headActions = el('div', 'session-head-actions');
    headActions.append(
      button('Help', 'help-button', () => {
        taskHelpOpen = true;
        render();
      }),
      el('span', 'session-status', pendingPicker ? 'Waiting for VS Code picker...' : 'Ready'),
      iconButton(t('close'), 'close', () => {
        editorTask = null;
        taskHelpOpen = false;
        render();
      })
    );
    shell.querySelector('.session-head')?.append(headActions);

    if (taskHelpOpen) {
      shell.append(taskHelpWindow());
    }

    const form = el('form', 'task-form session-form chat-session-form');
    const composer = el('section', 'session-composer chat-task-composer field-wide');
    const identity = el('div', 'composer-identity');
    identity.append(
      input('title', t('title'), task.title || '', true),
      repositoryField(task),
      branchField(task)
    );
    composer.append(identity, sessionPrompt(task), contextSection(task));

    const controls = el('div', 'composer-controls');
    const runnerControl = runnerField(task);
    const agentControl = agentField(task);
    const modelControl = modelField(task);
    const toolsControl = toolsProfileField(task);
    const permissionControl = permissionProfileField(task);
    runnerControl.classList.add('composer-control-runner');
    agentControl.classList.add('composer-control-agent');
    modelControl.classList.add('composer-control-model');
    toolsControl.classList.add('composer-control-tools');
    permissionControl.classList.add('composer-control-permission');
    controls.append(
      runnerControl,
      agentControl,
      modelControl,
      toolsControl,
      permissionControl,
      selectField('executionMode', t('executionMode'), task.executionMode || 'foreground', [
        ['manual', 'Manual handoff'],
        ['foreground', 'Foreground'],
        ['background', 'Background']
      ]),
      selectField('isolationMode', t('isolationMode'), task.isolationMode || 'none', [
        ['none', 'No isolation'],
        ['workspace', 'Current workspace'],
        ['worktree', 'Task worktree']
      ]),
      selectField('priority', t('priority'), task.priority || 'normal', [
        ['urgent', 'Urgent'],
        ['high', 'High'],
        ['normal', 'Normal'],
        ['low', 'Low']
      ])
    );
    composer.append(controls);

    const dock = el('section', 'session-dock composer-dock field-wide');
    dock.append(validationSummary(task), discoverySummary());
    form.append(composer, dock);

    const runnerSelect = form.querySelector('select[name="runner"]');
    runnerSelect?.addEventListener('change', () => {
      syncEditorFromForm(form);
      editorTask.runner = { id: runnerSelect.value };
      normalizeRunnerSelections(editorTask, true);
      render();
    });
    bindEditorFormEvents(form);

    const footer = el('div', 'drawer-actions session-actions');
    footer.append(
      button(t('cancel'), '', () => {
        editorTask = null;
        render();
      }),
      button(task.id ? 'Save task' : 'Create task', 'primary send-button', () => saveTask(form))
    );
    shell.append(form, footer);
    return shell;
  }

  function taskHelpWindow() {
    const layer = el('div', 'task-help-layer');
    const backdrop = el('button', 'task-help-backdrop');
    backdrop.type = 'button';
    backdrop.setAttribute('aria-label', 'Close task help');
    backdrop.addEventListener('click', () => {
      taskHelpOpen = false;
      render();
    });

    const dialog = el('section', 'task-help-window');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Task input help');
    dialog.innerHTML = `
      <div class="task-help-head">
        <div>
          <h3>Task input guide</h3>
          <p>Use this when you are not sure what a field controls before creating or editing a task.</p>
        </div>
      </div>
      <div class="task-help-list">
        ${taskHelpRows().map(([label, text]) => `
          <article>
            <strong>${escapeHtml(label)}</strong>
            <span>${escapeHtml(text)}</span>
          </article>
        `).join('')}
      </div>
    `;
    const close = button('Close', 'ghost-button', () => {
      taskHelpOpen = false;
      render();
    });
    dialog.querySelector('.task-help-head')?.append(close);
    layer.append(backdrop, dialog);
    return layer;
  }

  function taskHelpRows() {
    return [
      ['Title', 'Short name shown on the board and in task details. Keep it scannable.'],
      ['Repository', 'Git repository where the runner should inspect files, create worktrees, and capture changes.'],
      ['Base branch', 'Branch or ref used as the starting point for worktree runs and review context.'],
      ['Runner', 'Execution backend such as Copilot CLI, Codex CLI, a cloud runner, manual handoff, or a generic command.'],
      ['Agent', 'Agent or profile id passed to the selected runner. Use a known option or type a custom id.'],
      ['Model', 'Model id for the runner. Use provider-default/auto when you want the provider to choose.'],
      ['Tools', 'Tool and approval preset. Copilot CLI custom values such as mcp:name or allow-tool:name are passed as tool permissions.'],
      ['Approval policy', 'Permission posture for the run: read-only, ask, workspace edits, worktree edits, or explicit bypass.'],
      ['SPEC', 'Main instruction for the agent. Describe the outcome, constraints, and anything it must not change.'],
      ['Context', 'Optional files, folders, or notes that the agent may need beyond what it can infer from the repository.'],
      ['Run policy', 'Queue behavior and isolation choices: execution mode, edit location, and priority.']
    ];
  }

  function renderDetail(task) {
    const run = latestRunForTask(task);
    const shell = el('aside', 'drawer detail');
    const status = formatStatus(task.status);
    shell.innerHTML = `
      <div class="drawer-head">
        <div>
          <h2>${escapeHtml(task.title)}</h2>
          <p>${escapeHtml(task.repository?.label || '')} / ${escapeHtml(status)}</p>
        </div>
      </div>
      <section class="detail-block">
        <h3>Execution</h3>
        <div class="detail-grid">
          <span>Runner</span><strong>${escapeHtml(task.runner?.id || '')}</strong>
          <span>Branch</span><strong>${escapeHtml(task.branchBase || currentBranchName() || 'Current branch')}</strong>
          <span>Mode</span><strong>${escapeHtml(task.executionMode || '')}</strong>
          <span>Isolation</span><strong>${escapeHtml(task.isolationMode || '')}</strong>
          <span>Permissions</span><strong>${escapeHtml(permissionLabel(task.permissionProfile))}</strong>
          ${run?.worktreeBranch ? `<span>Worktree branch</span><strong>${escapeHtml(run.worktreeBranch)}</strong>` : ''}
          ${run?.worktreePath ? `<span>Worktree path</span><strong>${escapeHtml(run.worktreePath)}</strong>` : ''}
        </div>
      </section>
    `;
    shell.querySelector('.drawer-head')?.append(iconButton(t('close'), 'close', () => {
      selectedTaskId = null;
      render();
    }));

    if (run) {
      shell.append(renderRunReview(run));
    }

    const specBlock = el('section', 'detail-block');
    specBlock.innerHTML = `
      <h3>Spec</h3>
      <pre>${escapeHtml(task.spec)}</pre>
    `;
    shell.append(specBlock);

    const outputBlock = el('section', 'detail-block');
    outputBlock.innerHTML = `
      <h3>${escapeHtml(t('output'))}</h3>
      <pre>${escapeHtml(run?.summary || 'No output yet.')}</pre>
    `;
    shell.append(outputBlock);

    if (run?.error?.category) {
      const error = el('section', 'detail-block error-block');
      error.innerHTML = `
        <h3>Error</h3>
        <div class="error-chip">${escapeHtml(run.error.category)}</div>
        <pre>${escapeHtml(run.error.message || '')}</pre>
      `;
      shell.append(error);
    }

    if (run?.artifacts?.length) {
      const artifacts = el('section', 'detail-block artifacts');
      artifacts.innerHTML = '<h3>Artifacts</h3>';
      for (const artifact of run.artifacts) {
        artifacts.append(button(artifact.label, '', () => post('openArtifact', artifact.path)));
      }
      shell.append(artifacts);
    }

    if (task.status === 'waiting_for_input') {
      const manual = el('section', 'detail-block');
      manual.innerHTML = `
        <h3>${escapeHtml(t('manualResult'))}</h3>
        <textarea class="manual-result" placeholder="${escapeAttribute(t('manualOutputPlaceholder'))}"></textarea>
      `;
      const manualInput = manual.querySelector('textarea');
      manual.append(button(t('completeManualTask'), 'primary', () => {
        post('completeManualTask', { taskId: task.id, summary: manualInput.value });
      }));
      shell.append(manual);
    }

    const actions = el('div', 'drawer-actions');
    if (task.status === 'running' && task.lastRunId) {
      actions.append(button(t('cancel'), 'danger', () => post('cancelRun', task.lastRunId)));
    }
    actions.append(
      button('Edit', '', () => {
        editorTask = structuredClone(task);
        selectedTaskId = null;
        taskValidationMessage = '';
        render();
      }),
      button(task.status === 'failed' ? t('requeue') : t('enqueue'), '', () => post('enqueueTask', task.id)),
      button(t('duplicate'), '', () => post('duplicateTask', task.id)),
      button(t('delete'), 'danger', () => post('deleteTask', task.id)),
      button(t('close'), '', () => {
        selectedTaskId = null;
        render();
      })
    );
    shell.append(actions);
    return shell;
  }

  function renderRunReview(run) {
    const changedFiles = run.changedFiles || [];
    const stats = changedFileStats(changedFiles);
    const diffArtifact = (run.artifacts || []).find((artifact) => artifact.kind === 'diff');
    const rootPath = run.worktreePath || run.repository?.path || '';
    const section = el('section', 'detail-block review-block');
    section.innerHTML = `
      <h3>Review</h3>
      <div class="review-summary">
        <span><strong>${changedFiles.length}</strong> changed ${changedFiles.length === 1 ? 'file' : 'files'}</span>
        ${stats.hasStats ? `<span class="diff-added">+${escapeHtml(String(stats.additions))}</span><span class="diff-deleted">-${escapeHtml(String(stats.deletions))}</span>` : ''}
        ${run.worktreeBranch ? `<span>${escapeHtml(run.worktreeBranch)}</span>` : ''}
        ${run.exitCode !== undefined ? `<span>exit ${escapeHtml(String(run.exitCode))}</span>` : ''}
        ${diffArtifact ? '<span>diff ready</span>' : '<span>no diff artifact</span>'}
      </div>
    `;

    const reviewActions = el('div', 'review-actions');
    if (diffArtifact) {
      reviewActions.append(button('Open diff', '', () => post('openArtifact', diffArtifact.path)));
    }
    if (run.worktreePath) {
      reviewActions.append(button('Reveal worktree', '', () => post('revealPath', run.worktreePath)));
    }
    if (rootPath) {
      reviewActions.append(button('Reveal repository', '', () => post('revealPath', rootPath)));
    }
    if (reviewActions.childElementCount) {
      section.append(reviewActions);
    }

    if (changedFiles.length) {
      const files = el('details', 'changed-files');
      files.open = changedFiles.length <= 8;
      files.innerHTML = `<summary>Changed files</summary>`;
      const list = el('div', 'changed-file-list');
      for (const file of changedFiles) {
        const row = el('button', 'changed-file-row');
        row.type = 'button';
        row.innerHTML = `
          <span>${escapeHtml(fileStatusLabel(file.status))}</span>
          <strong>${escapeHtml(file.path)}</strong>
          ${hasFileStats(file) ? `<em>+${escapeHtml(String(file.additions || 0))} -${escapeHtml(String(file.deletions || 0))}</em>` : '<em></em>'}
        `;
        row.addEventListener('click', () => post('openChangedFile', { rootPath, relativePath: file.path }));
        list.append(row);
      }
      files.append(list);
      section.append(files);
    }

    return section;
  }

  function saveTask(form) {
    syncEditorFromForm(form);
    const data = Object.fromEntries(new FormData(form).entries());
    const selectedRepo = board.workspaceFolders.find((folder) => folder.path === data.repositoryPath);
    const runner = runnerOptionFor(data.runner);
    const agent = optionForManualValue(runner.agents, data.agent, 'Custom agent');
    const model = optionForManualValue(runner.models, data.model, 'Custom model');
    const toolsProfile = optionForManualValue(runner.toolsProfiles, data.toolsProfile, 'Custom tools profile');
    const task = {
      ...editorTask,
      title: data.title,
      spec: data.spec,
      repository: {
        type: selectedRepo ? 'workspace' : 'localPath',
        label: selectedRepo?.label || data.repositoryLabel || data.repositoryPath || 'Current workspace',
        path: data.repositoryPath || selectedRepo?.path
      },
      runner: { id: data.runner },
      agent: { id: agent.id, label: agent.label },
      model: { id: model.id, label: model.label },
      toolsProfile: { id: toolsProfile.id, label: toolsProfile.label },
      executionMode: data.executionMode,
      isolationMode: data.isolationMode,
      permissionProfile: data.permissionProfile,
      priority: data.priority,
      branchBase: data.branchBase || undefined,
      notes: data.notes || undefined,
      contextItems: collectContextItems(form)
    };

    const error = firstTaskValidationError(task);
    if (error) {
      taskValidationMessage = error;
      editorTask = task;
      render();
      return;
    }

    taskValidationMessage = '';
    post(task.id ? 'updateTask' : 'createTask', task);
    editorTask = null;
  }

  function repositoryField(task) {
    const wrap = el('div', 'field toolbar-field repository-picker');
    const value = task.repository?.path || '';
    const label = task.repository?.label || '';
    const tooltip = tooltipForField('repositoryPath');
    wrap.title = tooltip;
    wrap.innerHTML = `
      <span>Repo<em>required</em></span>
      <div class="inline-control">
        <input name="repositoryPath" value="${escapeAttribute(value)}" readonly title="${escapeAttribute(tooltip)}" placeholder="Select a Git repository folder">
        <input type="hidden" name="repositoryLabel" value="${escapeAttribute(label)}">
        <button type="button" class="button icon-like" title="${escapeAttribute(tooltip)}">Browse</button>
      </div>
      ${repositoryValidationMessage ? `<em class="field-error">${escapeHtml(repositoryValidationMessage)}</em>` : ''}
    `;
    wrap.querySelector('button')?.addEventListener('click', () => {
      const form = wrap.closest('form');
      if (form) {
        syncEditorFromForm(form);
      }
      pendingPicker = 'repository';
      render();
      post('pickRepository');
    });
    return wrap;
  }

  function branchField(task) {
    const branches = branchesForRepository(task.repository?.path);
    const selected = task.branchBase || branches.find((branch) => branch.current)?.name || '';
    if (branches.length === 0) {
      const field = input('branchBase', t('branchBase'), selected, false);
      field.append(helpText('Branches load after a valid Git repository is selected.'));
      return field;
    }
    const options = branches.map((branch) => [branch.name, branch.label]);
    if (selected && !branches.some((branch) => branch.name === selected)) {
      options.unshift([selected, `${selected} (selected)`]);
    }
    return selectField('branchBase', t('branchBase'), selected, options, true);
  }

  function runnerField(task) {
    const field = selectField('runner', t('runner'), task.runner?.id || 'copilot-cli', runnerOptions().map((runner) => [runner.id, runner.label]), true);
    const runner = runnerOptionFor(task.runner?.id);
    field.append(helpText(runner.description));
    return field;
  }

  function agentField(task) {
    const runner = runnerOptionFor(task.runner?.id);
    const value = task.agent?.id || runner.agents[0]?.id || 'default-agent';
    const field = comboField('agent', t('agent'), value, runner.agents, 'Select a known agent/profile, or type a custom id if the native app exposes one that is not listed.', true);
    field.append(helpText(optionById(runner.agents, value).description));
    return field;
  }

  function modelField(task) {
    const runner = runnerOptionFor(task.runner?.id);
    const value = task.model?.id || runner.defaultModelId || runner.models[0]?.id || 'provider-default';
    const field = comboField('model', t('model'), value, runner.models, 'Select a known model, type a custom model id, or keep provider-default for auto.', true);
    field.append(helpText(optionById(runner.models, value).description));
    return field;
  }

  function toolsProfileField(task) {
    const runner = runnerOptionFor(task.runner?.id);
    const value = task.toolsProfile?.id || runner.toolsProfiles[0]?.id || 'default-approvals';
    const field = comboField('toolsProfile', t('tools'), value, runner.toolsProfiles, 'Select a tools profile or type mcp:tool-name / allow-tool:tool-name for Copilot CLI.', true);
    field.append(helpText(optionById(runner.toolsProfiles, value).description));
    return field;
  }

  function permissionProfileField(task) {
    const field = selectField('permissionProfile', t('permissionProfile'), task.permissionProfile || 'allow_workspace', [
      ['read_only', 'Read only'],
      ['ask', 'Ask each time'],
      ['allow_workspace', 'Allow workspace edits'],
      ['allow_worktree', 'Allow worktree edits'],
      ['bypass', 'Bypass sandbox / approvals']
    ], true);
    field.append(helpText(permissionDescription(task.permissionProfile || 'allow_workspace', task.runner?.id)));
    return field;
  }

  function configGuide(task) {
    const branches = branchesForRepository(task.repository?.path);
    const runner = runnerOptionFor(task.runner?.id);
    const steps = [
      ['Repository', Boolean(task.repository?.path), task.repository?.path ? 'Git repository selected' : 'Pick a valid Git folder'],
      ['Base branch', Boolean(task.branchBase) || branches.length === 0, task.branchBase || (branches.length ? 'Select a branch' : 'Will use current branch')],
      ['Agent', Boolean(task.runner?.id && task.agent?.id && task.model?.id), `${runner.label} / ${task.model?.label || 'model'}`],
      ['Approvals', Boolean(task.toolsProfile?.id && task.permissionProfile), `${task.toolsProfile?.label || 'Tools'} / ${permissionLabel(task.permissionProfile)}`],
      ['SPEC', Boolean(task.spec?.trim()), task.spec?.trim() ? 'Prompt ready' : 'Write the task prompt']
    ];
    const guide = el('section', 'config-guide field-wide');
    guide.innerHTML = steps.map(([label, ready, detail], index) => `
      <div class="${ready ? 'step-ready' : 'step-missing'}">
        <strong><b>${index + 1}</b>${escapeHtml(label)}</strong>
        <span>${escapeHtml(detail)}</span>
      </div>
    `).join('');
    return guide;
  }

  function validationSummary(task) {
    const issues = taskValidationIssues(task);
    const summary = el('section', `validation-summary ${issues.length ? 'has-issues' : 'is-ready'}`);
    if (issues.length === 0) {
      summary.innerHTML = '<strong>Ready to create</strong><span>Required setup is complete. Context is optional.</span>';
      return summary;
    }
    summary.innerHTML = `
      <strong>${issues.length} required item${issues.length === 1 ? '' : 's'} missing</strong>
      <span>${escapeHtml(taskValidationMessage || issues.join(' / '))}</span>
    `;
    return summary;
  }

  function discoverySummary() {
    const discovery = board?.repositoryDiscovery;
    const summary = el('section', 'discovery-summary');
    if (!discovery) {
      summary.innerHTML = '<span>Agent setup will refresh after repository selection.</span>';
      return summary;
    }
    const paths = discovery.repositoryPaths || [];
    summary.innerHTML = `
      <strong>Repository discovery</strong>
      <span>${escapeHtml(String(discovery.githubAgents || 0))} Copilot agent(s) / ${escapeHtml(String(discovery.toolsProfiles || 0))} tool profile(s) / ${escapeHtml(String(paths.length))} scanned path(s)</span>
    `;
    return summary;
  }

  function contextSection(task) {
    const section = el('section', 'context-section field-wide');
    section.innerHTML = `
      <div class="context-head">
        <div>
          <h3>Context</h3>
          <p>${(task.contextItems || []).length ? `${task.contextItems.length} attached item(s)` : 'Add only what the agent cannot infer from the repository.'}</p>
        </div>
        <div class="context-actions"></div>
      </div>
    `;
    const actions = section.querySelector('.context-actions');
    actions.append(
      button('+ Files', 'ghost-button', () => {
        syncEditorFromForm(section.closest('form'));
        pendingPicker = 'context';
        render();
        post('pickContextDiskFiles', { repositoryPath: editorTask.repository?.path });
      }),
      button('+ Repo', 'ghost-button', () => {
        syncEditorFromForm(section.closest('form'));
        pendingPicker = 'context';
        render();
        post('pickContextRepositoryFiles', { repositoryPath: editorTask.repository?.path });
      }),
      button('+ Folder', 'ghost-button', () => {
        syncEditorFromForm(section.closest('form'));
        pendingPicker = 'context';
        render();
        post('pickContextFolderFiles', { repositoryPath: editorTask.repository?.path });
      }),
      button('+ Note', 'ghost-button', () => {
        syncEditorFromForm(section.closest('form'));
        editorTask.contextItems = [
          ...(editorTask.contextItems || []),
          { id: uniqueId(), kind: 'note', label: 'Context note', content: '', description: '' }
        ];
        render();
      })
    );
    [...actions.querySelectorAll('button')].forEach((item) => {
      item.title = 'Attach extra files, folders, or notes that should be included with the task prompt.';
    });

    const items = el('div', 'context-list');
    if (!task.contextItems?.length) {
      items.append(el('div', 'empty compact', 'No context attached yet.'));
    } else {
      for (const item of task.contextItems) {
        items.append(contextItemRow(item));
      }
    }
    section.append(items);
    return section;
  }

  function contextItemRow(item) {
    const row = el('div', `context-item context-${item.kind || 'file'}`);
    row.dataset.id = item.id;
    const icon = item.kind === 'folder' ? 'dir' : item.kind === 'note' ? 'note' : 'file';
    row.innerHTML = `
      <div class="context-meta">
        <strong>${escapeHtml(icon)}</strong>
        <div>
          <span>${escapeHtml(item.label || item.path || 'Context')}</span>
          ${item.path ? `<small>${escapeHtml(item.path)}</small>` : ''}
        </div>
      </div>
      <input class="context-description" data-id="${escapeAttribute(item.id)}" value="${escapeAttribute(item.description || '')}" title="Explain how this context should guide the agent." placeholder="Why this context matters">
      ${item.kind === 'note' ? `<textarea class="context-content" data-id="${escapeAttribute(item.id)}" title="Write inline context that will be included in the prompt." placeholder="Context note">${escapeHtml(item.content || '')}</textarea>` : ''}
      <button type="button" class="button danger">Remove</button>
    `;
    row.querySelector('button')?.addEventListener('click', () => {
      editorTask.contextItems = (editorTask.contextItems || []).filter((candidate) => candidate.id !== item.id);
      render();
    });
    return row;
  }

  function input(name, label, value, required) {
    const wrap = el('label', 'field');
    const tooltip = tooltipForField(name);
    wrap.title = tooltip;
    wrap.innerHTML = `<span>${escapeHtml(label)}${required ? '<em>required</em>' : ''}</span><input name="${name}" value="${escapeAttribute(value)}" title="${escapeAttribute(tooltip)}" ${required ? 'required' : ''}>`;
    return wrap;
  }

  function textarea(name, label, value, required) {
    const wrap = el('label', 'field field-wide');
    const tooltip = tooltipForField(name);
    wrap.title = tooltip;
    wrap.innerHTML = `<span>${escapeHtml(label)}</span><textarea name="${name}" title="${escapeAttribute(tooltip)}" ${required ? 'required' : ''}>${escapeHtml(value)}</textarea>`;
    return wrap;
  }

  function sessionPrompt(task) {
    const wrap = el('label', 'field field-wide session-prompt');
    const tooltip = tooltipForField('spec');
    wrap.title = tooltip;
    wrap.innerHTML = `
      <span>SPEC<em>required</em></span>
      <textarea name="spec" title="${escapeAttribute(tooltip)}" required placeholder="What would you like to automate?">${escapeHtml(task.spec || '')}</textarea>
    `;
    return wrap;
  }

  function selectField(name, label, value, options, required) {
    const wrap = el('label', 'field');
    const tooltip = tooltipForField(name);
    wrap.title = tooltip;
    const optionHtml = options.map(([optionValue, optionLabel]) => {
      const selected = optionValue === value ? 'selected' : '';
      return `<option value="${escapeAttribute(optionValue)}" ${selected}>${escapeHtml(optionLabel)}</option>`;
    }).join('');
    wrap.innerHTML = `<span>${escapeHtml(label)}${required ? '<em>required</em>' : ''}</span><select name="${name}" title="${escapeAttribute(tooltip)}" ${required ? 'required' : ''}>${optionHtml}</select>`;
    return wrap;
  }

  function comboField(name, label, value, options, tooltip, required) {
    const known = options.some((option) => option.id === value);
    const wrap = el('label', 'field combo-field');
    wrap.title = tooltip;
    const optionHtml = [
      ...options.map((option) => {
        const selected = known && option.id === value ? 'selected' : '';
        return `<option value="${escapeAttribute(option.id)}" ${selected}>${escapeHtml(option.label)}</option>`;
      }),
      `<option value="__custom" ${known ? '' : 'selected'}>Custom value...</option>`
    ].join('');
    wrap.innerHTML = `
      <span>${escapeHtml(label)}${required ? '<em>required</em>' : ''}</span>
      <div class="combo-control">
        <select name="${name}Preset" title="${escapeAttribute(tooltip)}">${optionHtml}</select>
        <input name="${name}" value="${escapeAttribute(value)}" title="${escapeAttribute(tooltip)}" placeholder="auto or custom id" ${required ? 'required' : ''}>
      </div>
    `;
    const select = wrap.querySelector('select');
    const inputEl = wrap.querySelector('input');
    select.addEventListener('change', () => {
      if (select.value !== '__custom') {
        inputEl.value = select.value;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      inputEl.focus();
    });
    return wrap;
  }

  function bindEditorFormEvents(form) {
    form.addEventListener('input', (event) => {
      if (!editorTask || event.target?.name?.endsWith('Preset')) {
        return;
      }
      refreshEditorFeedback(form);
    });
    form.addEventListener('change', (event) => {
      if (!editorTask || event.target?.name === 'runner') {
        return;
      }
      refreshEditorFeedback(form);
    });
  }

  function refreshEditorFeedback(form) {
    syncEditorFromForm(form);
    const dock = form.querySelector('.composer-dock');
    const currentSummary = dock?.querySelector('.validation-summary');
    if (dock && currentSummary) {
      currentSummary.replaceWith(validationSummary(editorTask));
    }
  }

  function handleColumnDrop(event, columnId, list) {
    event.preventDefault();
    if (!draggedTaskId) {
      return;
    }
    const draggedTask = board.tasks.find((task) => task.id === draggedTaskId);
    if (!draggedTask) {
      return;
    }
    if (columnId === 'pending') {
      if (draggedTask.status === 'queued' || draggedTask.status === 'failed') {
        post('moveTaskToPending', draggedTaskId);
      }
      return;
    }
    if (columnId !== 'queued') {
      return;
    }
    if (draggedTask.status !== 'queued') {
      post('enqueueTask', draggedTaskId);
      return;
    }
    const cards = [...list.querySelectorAll('.task-card')];
    const target = event.target.closest('.task-card');
    const ids = cards.map((card) => card.dataset.taskId).filter(Boolean).filter((id) => id !== draggedTaskId);
    if (target?.dataset?.taskId) {
      const targetIndex = ids.indexOf(target.dataset.taskId);
      ids.splice(targetIndex, 0, draggedTaskId);
    } else {
      ids.push(draggedTaskId);
    }
    post('reorderQueued', ids);
  }

  function toggleQueueExecutionMode() {
    const next = board.queueExecutionMode === 'automatic' ? 'manual' : 'automatic';
    board.queueExecutionMode = next;
    post('setQueueExecutionMode', next);
    render();
  }

  function queueModeLabel() {
    return board?.queueExecutionMode === 'automatic' ? t('queueAutomatic') : t('queueManual');
  }

  function setBoardGroupMode(mode) {
    boardGroupMode = ['repository', 'runner'].includes(mode) ? mode : 'none';
    persistViewState();
    render();
  }

  function persistViewState() {
    vscode.setState?.({
      ...(vscode.getState?.() || {}),
      boardGroupMode,
      collapsedTaskGroups,
      collapsedSidebarSections
    });
  }

  function normalizeCollapsedState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(Object.entries(value).filter(([key, collapsed]) => key && collapsed === true));
  }

  function isSidebarSectionCollapsed(sectionId) {
    return collapsedSidebarSections[sectionId] === true;
  }

  function toggleSidebarSection(sectionId) {
    collapsedSidebarSections = { ...collapsedSidebarSections };
    if (collapsedSidebarSections[sectionId]) {
      delete collapsedSidebarSections[sectionId];
    } else {
      collapsedSidebarSections[sectionId] = true;
    }
    persistViewState();
    render();
  }

  function taskGroupCollapseKey(columnId, groupKey) {
    return `${boardGroupMode}|${columnId}|${groupKey}`;
  }

  function isTaskGroupCollapsed(columnId, groupKey) {
    return collapsedTaskGroups[taskGroupCollapseKey(columnId, groupKey)] === true;
  }

  function toggleTaskGroup(columnId, groupKey) {
    const key = taskGroupCollapseKey(columnId, groupKey);
    collapsedTaskGroups = { ...collapsedTaskGroups };
    if (collapsedTaskGroups[key]) {
      delete collapsedTaskGroups[key];
    } else {
      collapsedTaskGroups[key] = true;
    }
    persistViewState();
    render();
  }

  function collapsibleSectionHead(label, meta, collapsed, contentId, onToggle) {
    const head = el('div', 'section-head section-head-collapsible');
    const toggle = el('button', 'collapse-toggle section-toggle');
    toggle.type = 'button';
    toggle.title = `${collapsed ? t('expand') : t('collapse')} ${label}`;
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-controls', contentId);
    toggle.innerHTML = `
      <span class="collapse-chevron" aria-hidden="true">${collapsed ? '>' : 'v'}</span>
      <span class="section-title">${escapeHtml(label)}</span>
      ${meta ? `<span class="section-meta">${escapeHtml(meta)}</span>` : ''}
    `;
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      onToggle();
    });
    head.append(toggle);
    return head;
  }

  function collapsibleTaskGroupHead(group, columnId, collapsed, contentId) {
    const head = el('div', 'task-group-head');
    const toggle = el('button', 'collapse-toggle task-group-toggle');
    toggle.type = 'button';
    toggle.title = `${collapsed ? t('expand') : t('collapse')} ${group.label}`;
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-controls', contentId);
    toggle.innerHTML = `
      <span class="collapse-chevron" aria-hidden="true">${collapsed ? '>' : 'v'}</span>
      <strong>${escapeHtml(group.label)}</strong>
      <span>${group.tasks.length}</span>
    `;
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleTaskGroup(columnId, group.key);
    });
    head.append(toggle);
    return head;
  }

  function toggleCompletedVisibility() {
    const next = !board.completedVisible;
    board.completedVisible = next;
    post('setCompletedVisible', next);
    render();
  }

  function createDraftTask() {
    const firstRepo = board?.workspaceFolders?.[0];
    const branches = firstRepo?.path ? branchesForRepository(firstRepo.path) : [];
    const runner = runnerOptionFor('copilot-cli');
    const agent = runner.agents[0] || { id: 'default-agent', label: 'Default agent' };
    const model = optionById(runner.models, runner.defaultModelId) || runner.models[0] || { id: 'provider-default', label: 'Provider default' };
    const toolsProfile = runner.toolsProfiles[0] || { id: 'default-approvals', label: 'Default Approvals' };
    return {
      title: '',
      spec: '',
      repository: {
        type: 'workspace',
        label: firstRepo?.label || 'Current workspace',
        path: firstRepo?.path
      },
      runner: { id: runner.id },
      agent: { id: agent.id, label: agent.label },
      model: { id: model.id, label: model.label },
      toolsProfile: { id: toolsProfile.id, label: toolsProfile.label },
      executionMode: 'foreground',
      isolationMode: 'workspace',
      permissionProfile: 'allow_workspace',
      priority: 'normal',
      branchBase: branches.find((branch) => branch.current)?.name || currentBranchName(),
      notes: '',
      contextItems: []
    };
  }

  function currentBranchName() {
    return (board?.workspaceBranches || []).find((branch) => branch.current)?.name;
  }

  function branchesForRepository(repositoryPath) {
    if (!repositoryPath) {
      return [];
    }
    return board?.repositoryBranches?.[repositoryPath] || (repositoryPath === board?.workspaceFolders?.[0]?.path ? board.workspaceBranches || [] : []);
  }

  function runnerOptions() {
    return board?.runnerOptions?.length
      ? board.runnerOptions
      : (board?.runners || []).map((runner) => ({
        ...runner,
        description: 'Runner configuration.',
        agents: [{ id: 'default-agent', label: 'Default agent', description: 'Use the default agent.' }],
        models: [{ id: 'provider-default', label: 'Provider default', description: 'Use the provider default model.' }],
        toolsProfiles: [{ id: 'default-approvals', label: 'Default Approvals', description: 'Use the default tools profile.' }]
      }));
  }

  function runnerOptionFor(runnerId) {
    return runnerOptions().find((runner) => runner.id === runnerId) || runnerOptions()[0] || {
      id: 'manual',
      label: 'Manual handoff',
      description: 'Fallback manual runner.',
      agents: [{ id: 'default-agent', label: 'Default agent', description: 'Use the default agent.' }],
      models: [{ id: 'provider-default', label: 'Provider default', description: 'Use the provider default model.' }],
      toolsProfiles: [{ id: 'default-approvals', label: 'Default Approvals', description: 'Use the default tools profile.' }]
    };
  }

  function optionById(options, id) {
    return options.find((option) => option.id === id) || { id: id || 'default', label: id || 'Default', description: '' };
  }

  function optionForManualValue(options, value, fallbackLabel) {
    const id = String(value || '').trim();
    const known = options.find((option) => option.id === id);
    if (known) {
      return known;
    }
    return {
      id,
      label: id || fallbackLabel,
      description: 'Custom value typed in the task editor.'
    };
  }

  function normalizeRunnerSelections(task, forceReset) {
    const runner = runnerOptionFor(task.runner?.id);
    task.runner = { id: runner.id };

    if (forceReset || !task.agent?.id) {
      const agent = runner.agents[0];
      task.agent = { id: agent.id, label: agent.label };
    }
    if (forceReset || !task.model?.id) {
      const model = optionById(runner.models, runner.defaultModelId);
      task.model = { id: model.id, label: model.label };
    }
    if (forceReset || !task.toolsProfile?.id) {
      const profile = runner.toolsProfiles[0];
      task.toolsProfile = { id: profile.id, label: profile.label };
    }
  }

  function syncEditorFromForm(form) {
    if (!editorTask || !form) {
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    const runner = runnerOptionFor(data.runner || editorTask.runner?.id);
    const agent = optionForManualValue(runner.agents, data.agent || editorTask.agent?.id, 'Custom agent');
    const model = optionForManualValue(runner.models, data.model || editorTask.model?.id, 'Custom model');
    const toolsProfile = optionForManualValue(runner.toolsProfiles, data.toolsProfile || editorTask.toolsProfile?.id, 'Custom tools profile');

    editorTask.title = data.title ?? editorTask.title;
    editorTask.spec = data.spec ?? editorTask.spec;
    editorTask.repository = {
      type: board.workspaceFolders.some((folder) => folder.path === data.repositoryPath) ? 'workspace' : 'localPath',
      label: data.repositoryLabel || editorTask.repository?.label || data.repositoryPath || 'Current workspace',
      path: data.repositoryPath || editorTask.repository?.path
    };
    editorTask.runner = { id: runner.id };
    editorTask.agent = { id: agent.id, label: agent.label };
    editorTask.model = { id: model.id, label: model.label };
    editorTask.toolsProfile = { id: toolsProfile.id, label: toolsProfile.label };
    editorTask.executionMode = data.executionMode || editorTask.executionMode;
    editorTask.isolationMode = data.isolationMode || editorTask.isolationMode;
    editorTask.permissionProfile = data.permissionProfile || editorTask.permissionProfile;
    editorTask.priority = data.priority || editorTask.priority;
    editorTask.branchBase = data.branchBase || undefined;
    editorTask.notes = data.notes || undefined;
    editorTask.contextItems = collectContextItems(form);
  }

  function collectContextItems(form) {
    const rows = [...form.querySelectorAll('.context-item')];
    return rows.map((row) => {
      const id = row.dataset.id;
      const source = (editorTask.contextItems || []).find((item) => item.id === id) || {};
      return {
        ...source,
        id: id || source.id || uniqueId(),
        description: row.querySelector('.context-description')?.value || undefined,
        content: row.querySelector('.context-content')?.value || source.content || undefined
      };
    });
  }

  function firstTaskValidationError(task) {
    const issues = taskValidationIssues(task);
    if (issues.length) {
      return issues.join('\n');
    }
    return '';
  }

  function taskValidationIssues(task) {
    const issues = [];
    if (!task.repository?.path) {
      issues.push('Repository');
    }
    if (task.repository?.path && !task.branchBase && branchesForRepository(task.repository.path).length > 0) {
      issues.push('Base branch');
    }
    if (!task.runner?.id) {
      issues.push('Runner');
    }
    if (!task.agent?.id) {
      issues.push('Agent');
    }
    if (!task.model?.id) {
      issues.push('Model');
    }
    if (!task.toolsProfile?.id) {
      issues.push('Tools profile');
    }
    if (!task.permissionProfile) {
      issues.push('Approval policy');
    }
    if (!task.title?.trim()) {
      issues.push('Title');
    }
    if (!task.spec?.trim()) {
      issues.push('SPEC prompt');
    }
    return issues;
  }

  function helpText(value) {
    return el('small', 'field-help', value || '');
  }

  function permissionLabel(value) {
    return {
      read_only: 'Read only',
      ask: 'Ask each time',
      allow_workspace: 'Workspace edits',
      allow_worktree: 'Worktree edits',
      bypass: 'Bypass'
    }[value] || 'Approval policy';
  }

  function permissionDescription(value, runnerId) {
    if (value === 'read_only') {
      return 'Analysis only. File writes and shell mutations are blocked where the runner supports it.';
    }
    if (value === 'ask') {
      return 'Interactive approval profile. Non-interactive CLI runners may reject this.';
    }
    if (value === 'allow_worktree') {
      return 'Prefer edits inside a task worktree, with normal approvals/tool policy.';
    }
    if (value === 'bypass') {
      return String(runnerId || '').startsWith('codex')
        ? 'Codex runs with danger-full-access. Use only when you trust the task and repository.'
        : 'Do not add AgenticKanbasutra deny rules. Actual approval behavior depends on the selected runner.';
    }
    return 'Allow normal edits in the selected workspace according to the tools profile.';
  }

  function latestRunForTask(task) {
    return board.runs.find((item) => item.id === task.lastRunId) || board.runs.filter((item) => item.taskId === task.id).at(-1);
  }

  function isActiveStatus(status) {
    return status === 'running' || status === 'waiting_for_input' || status === 'waiting_for_approval';
  }

  function statusClass(status) {
    return String(status || 'unknown').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  }

  function changedFileStats(files) {
    return files.reduce((stats, file) => {
      if (hasFileStats(file)) {
        stats.hasStats = true;
        stats.additions += file.additions || 0;
        stats.deletions += file.deletions || 0;
      }
      return stats;
    }, { additions: 0, deletions: 0, hasStats: false });
  }

  function hasFileStats(file) {
    return typeof file.additions === 'number' || typeof file.deletions === 'number';
  }

  function fileStatusLabel(status) {
    return {
      added: 'A',
      modified: 'M',
      deleted: 'D',
      renamed: 'R',
      unknown: '?'
    }[status] || '?';
  }

  function tooltipForField(name) {
    return {
      title: 'Short label shown on the task card and detail drawer.',
      spec: 'Main prompt or task instruction that the selected runner executes.',
      repositoryPath: 'Local folder to run the task in. It must be a valid Git repository.',
      branchBase: 'Base branch/ref used by the runner, especially for worktree isolation.',
      runner: 'Execution backend: local CLI, cloud runner, manual handoff, or generic command.',
      agent: 'Agent/profile id. Select a known value or type the id used by the native app.',
      model: 'Model id. Use provider-default for auto, or type a model id to force it.',
      toolsProfile: 'Tool/approval preset. For Copilot CLI, custom values mcp:name or allow-tool:name are passed as --allow-tool.',
      executionMode: 'Whether the task is manual, foreground, or background execution.',
      isolationMode: 'Where edits are allowed: current workspace, no isolation, or a task worktree.',
      permissionProfile: 'Permission policy passed to supported runners.',
      priority: 'Queue ordering weight for pending and queued tasks.'
    }[name] || 'Task configuration field.';
  }

  function uniqueId() {
    return `ctx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function sortQueued(tasks) {
    const weights = { urgent: 0, high: 1, normal: 2, low: 3 };
    return [...tasks].sort((a, b) => {
      const priorityDelta = weights[a.priority] - weights[b.priority];
      if (priorityDelta !== 0) return priorityDelta;
      const rankDelta = (a.queueRank || 999999) - (b.queueRank || 999999);
      if (rankDelta !== 0) return rankDelta;
      return String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt));
    });
  }

  function sortByActivity(tasks) {
    return [...tasks].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  function groupedTasks(tasks, mode) {
    const groups = new Map();
    for (const task of tasks) {
      const group = taskGroupInfo(task, mode);
      if (!groups.has(group.key)) {
        groups.set(group.key, { ...group, tasks: [] });
      }
      groups.get(group.key).tasks.push(task);
    }
    return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
  }

  function taskGroupInfo(task, mode) {
    if (mode === 'runner') {
      const runner = runnerOptionFor(task.runner?.id);
      return {
        key: `runner:${task.runner?.id || 'unknown'}`,
        label: runner.label || task.runner?.id || 'Unknown runner'
      };
    }
    const repositoryPath = task.repository?.path || '';
    const repositoryLabel = mainRepositoryName(task.repository);
    return {
      key: `repository:${repositoryPath.toLowerCase() || repositoryLabel.toLowerCase()}`,
      label: repositoryLabel
    };
  }

  function mainRepositoryName(repository) {
    const pathValue = String(repository?.path || '').replace(/[\\/]+$/, '');
    if (pathValue) {
      const parts = pathValue.split(/[\\/]+/).filter(Boolean);
      return parts.at(-1) || pathValue;
    }
    return repository?.label || 'Unknown repository';
  }

  function post(type, payload) {
    vscode.postMessage({ type, payload });
  }

  function button(label, variant, onClick) {
    const element = el('button', `button ${variant || ''}`.trim(), label);
    element.type = 'button';
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return element;
  }

  function iconButton(label, icon, onClick) {
    const element = button('', 'icon-button', onClick);
    element.innerHTML = iconMarkup(icon);
    element.title = label;
    element.setAttribute('aria-label', label);
    return element;
  }

  function compactButton(label, icon, onClick) {
    const element = iconButton(label, icon, onClick);
    element.classList.add('compact-icon-button');
    return element;
  }

  function compactTextButton(text, label, onClick) {
    const element = button(text, 'compact-text-button', onClick);
    element.title = label;
    element.setAttribute('aria-label', label);
    return element;
  }

  function iconMarkup(icon) {
    const icons = {
      queue: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10"/><path d="M4 12h10"/><path d="M4 18h10"/><path d="m17 8 4 4-4 4"/></svg>',
      play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
      pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14"/><path d="M15 5v14"/></svg>',
      pulse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>',
      shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 2.8 8.2 7 10 4.2-1.8 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-5"/></svg>',
      bot: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3"/><rect x="5" y="7" width="14" height="11" rx="3"/><path d="M8 21h8"/><path d="M9 12h.01"/><path d="M15 12h.01"/></svg>',
      sparkle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2.1L22 19l-2.3.9L19 22l-.9-2.1L16 19l2.1-.9z"/></svg>',
      check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
      web: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/><path d="M14 4h6v6"/><path d="m10 14 10-10"/></svg>',
      folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 3h9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7v11"/></svg>',
      external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"/><path d="m21 3-9 9"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/></svg>',
      settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/><path d="M4 12h2"/><path d="M18 12h2"/><path d="M12 4v2"/><path d="M12 18v2"/><path d="m6.3 6.3 1.4 1.4"/><path d="m16.3 16.3 1.4 1.4"/><path d="m17.7 6.3-1.4 1.4"/><path d="m7.7 16.3-1.4 1.4"/></svg>',
      eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
      copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></svg>',
      trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>',
      close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>'
    };
    return icons[icon] || '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>';
  }

  function providerUsageSnapshots() {
    const byId = new Map((board.providerUsage || []).map((snapshot) => [snapshot.providerId, snapshot]));
    return ['codex', 'claude', 'copilot'].map((providerId) => byId.get(providerId) || {
      providerId,
      status: 'unknown',
      confidence: providerId === 'copilot' ? 'manual' : 'unavailable',
      label: providerId === 'copilot' ? 'View on web' : 'Not checked',
      source: providerId === 'copilot' ? 'copilot-web' : 'manual'
    });
  }

  function taskProviderUsage(task) {
    const providerId = providerIdForRunner(task.runner?.id || '');
    if (!providerId) {
      return undefined;
    }
    return providerUsageSnapshots().find((snapshot) => snapshot.providerId === providerId);
  }

  function providerIdForRunner(runnerId) {
    if (String(runnerId).startsWith('codex')) return 'codex';
    if (String(runnerId).startsWith('claude')) return 'claude';
    if (String(runnerId).startsWith('copilot')) return 'copilot';
    return undefined;
  }

  function providerUsageChipMarkup(snapshot) {
    const label = `${providerLabel(snapshot.providerId)} ${statusLabel(snapshot.status)}`;
    return `<span class="card-provider-chip usage-${escapeAttribute(snapshot.status || 'unknown')}" title="${escapeAttribute(usageTooltip(snapshot))}">${escapeHtml(label)}</span>`;
  }

  function providerUsageMeta(snapshots) {
    const blocked = snapshots.find((snapshot) => snapshot.status === 'blocked');
    if (blocked) {
      return `${providerLabel(blocked.providerId)} ${statusLabel('blocked')}`;
    }
    const warningCount = snapshots.filter((snapshot) => snapshot.status === 'warning').length;
    if (warningCount > 0) {
      return `${warningCount} ${String(t('usageWarning')).toLowerCase()}`;
    }
    const checkedCount = snapshots.filter((snapshot) => snapshot.checkedAt).length;
    return checkedCount > 0 ? `${checkedCount}/3 checked` : t('usageUnknown');
  }

  function providerLabel(providerId) {
    return {
      codex: 'Codex',
      claude: 'Claude',
      copilot: 'Copilot'
    }[providerId] || 'Provider';
  }

  function statusLabel(status) {
    return {
      healthy: t('usageHealthy'),
      warning: t('usageWarning'),
      blocked: t('usageBlocked'),
      unknown: t('usageUnknown')
    }[status] || t('usageUnknown');
  }

  function usageTooltip(snapshot) {
    const windows = Array.isArray(snapshot.usageWindows)
      ? snapshot.usageWindows.map((window) => {
        const used = window.percentUsed !== undefined ? `${window.percentUsed}% used` : undefined;
        const remaining = window.percentRemaining !== undefined ? `${window.percentRemaining}% remaining` : undefined;
        // Prefer computing from resetAt so stale persisted seconds don't mislead
        const resetTimestamp = window.resetAt ? new Date(window.resetAt).getTime() : NaN;
        const resetSeconds = Number.isFinite(resetTimestamp)
          ? Math.max(0, Math.round((resetTimestamp - Date.now()) / 1000))
          : window.resetAfterSeconds;
        const reset = resetSeconds !== undefined ? `resets in ${formatDuration(resetSeconds)}` : undefined;
        return `${window.label || window.id}: ${[used, remaining, reset].filter(Boolean).join(', ')}`;
      })
      : [];
    const lines = [
      `${providerLabel(snapshot.providerId)}: ${snapshot.label || statusLabel(snapshot.status)}`,
      snapshot.percentRemaining !== undefined ? `${snapshot.percentRemaining}% remaining` : undefined,
      snapshot.percentUsed !== undefined ? `${snapshot.percentUsed}% used` : undefined,
      ...windows,
      `${t('usageSource')}: ${snapshot.source || 'unknown'}`,
      `${t('usageConfidence')}: ${snapshot.confidence || 'unknown'}`,
      `${t('usageLastChecked')}: ${snapshot.checkedAt ? relativeTime(snapshot.checkedAt) : 'never'}`,
      `${t('usageReset')}: ${snapshot.resetAt ? formatResetAt(snapshot.resetAt) : 'unknown'}`,
      snapshot.rawSummary ? shorten(snapshot.rawSummary, 220) : t('usageUnavailable')
    ];
    return lines.filter(Boolean).join('\n');
  }

  function formatResetAt(value) {
    if (!value) return 'unknown';
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) {
      const secondsUntil = Math.round((timestamp - Date.now()) / 1000);
      if (secondsUntil > 60) return `in ${formatDuration(secondsUntil)}`;
      if (secondsUntil >= 0) return 'soon';
    }
    return value;
  }

  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    return `${minutes}m`;
  }

  function relativeTime(value) {
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) {
      return 'unknown';
    }
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 60) {
      return `${seconds}s ago`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  function formatStatus(status) {
    return String(status || '').replace(/_/g, ' ');
  }

  function slug(value) {
    return String(value || 'default').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
  }

  function shorten(value, max) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
  }

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#096;');
  }
})();
