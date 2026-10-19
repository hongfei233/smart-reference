/* global acquireVsCodeApi, ResizeObserver */
(() => {
    'use strict';
    const vscode = acquireVsCodeApi();
    const saved = vscode.getState() || {};
    const columns = [
        { key: 'line', label: '行', width: 48, min: 40 },
        { key: 'text', label: '代码', width: 480, min: 180 },
        { key: 'file', label: '文件', width: 145, min: 70 },
        { key: 'workspace', label: '工作区', width: 115, min: 70 },
        { key: 'member', label: '包含成员', width: 160, min: 80 },
        { key: 'type', label: '包含类型', width: 145, min: 80 }
    ];
    const legacyColumnKeys = ['text', 'file', 'line', 'column', 'workspace', 'member', 'type'];
    const restoredColumns = columns.filter((column) => !Array.isArray(saved.visibleColumns) || saved.visibleColumns.includes(column.key)).map((column) => column.key);
    const ui = {
        filter: typeof saved.filter === 'string' ? saved.filter : '',
        group: ['file', 'workspace', 'flat'].includes(saved.group) ? saved.group : 'file',
        wrap: saved.wrap === true,
        preview: saved.preview === true,
        stripedRows: saved.stripedRows !== false,
        columnWidths: Object.fromEntries(columns.map((column) => {
            const width = saved.columnWidths?.[column.key] ?? saved.widths?.[legacyColumnKeys.indexOf(column.key)];
            return [column.key, Number.isFinite(width) ? Math.max(column.min, Math.min(4000, width)) : column.width];
        })),
        visibleColumns: restoredColumns.length ? restoredColumns : columns.map((column) => column.key),
        selected: typeof saved.selected === 'string' ? saved.selected : '',
        collapsed: new Set(Array.isArray(saved.collapsed) ? saved.collapsed.filter((entry) => typeof entry === 'string') : []),
        scrollTop: Number.isFinite(saved.scrollTop) ? Math.max(0, saved.scrollTop) : 0,
        scrollLeft: Number.isFinite(saved.scrollLeft) ? Math.max(0, saved.scrollLeft) : 0
    };
    const elements = Object.fromEntries([
        'query-title', 'counts', 'refresh', 'cancel', 'clear', 'group', 'collapse', 'wrap', 'preview-toggle', 'filter', 'banner',
        'results-layout', 'table-scroll', 'table-content', 'table-header', 'virtual-space', 'visible-rows', 'empty',
        'preview-pane', 'preview-title', 'preview-code', 'selected-path',
        'columns-toggle', 'column-menu', 'column-options', 'columns-reset', 'stripes-toggle', 'search-mode'
    ].map((id) => [id, document.getElementById(id)]));
    let snapshot = { queryId: -1, status: 'idle', items: [], label: '', warnings: [], stale: false, message: '', enriching: false };
    let filtered = [];
    let entries = [];
    let offsets = [0];
    const heights = new Map();
    let renderFrame = 0;
    let filterTimer;
    let saveTimer;
    let requestId = 0;
    let previewItemId = '';
    let restoring = true;
    let activeResize;
    let pendingSnapshot;
    let menuAnchor;
    let menuReturnFocus;

    /** 将界面偏好和滚动位置保存到视图状态。 */
    function saveState() {
        vscode.setState({ ...ui, collapsed: Array.from(ui.collapsed) });
    }

    /** 合并滚动产生的状态保存操作。 */
    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveState, 150);
    }

    /** 通过可信查询编号和引用标识请求编辑器导航。 */
    function navigate(item, preview) {
        vscode.postMessage({ type: 'navigate', queryId: snapshot.queryId, id: item.id, preview });
    }

    /** 按固定顺序返回用户选择显示的列。 */
    function getVisibleColumns() {
        return columns.filter((column) => ui.visibleColumns.includes(column.key));
    }

    /** 根据当前按钮或鼠标位置将列菜单限制在视图范围内。 */
    function positionColumnMenu() {
        const menu = elements['column-menu'];
        const rect = elements['columns-toggle'].getBoundingClientRect();
        const left = menuAnchor ? menuAnchor.x : rect.left;
        const top = menuAnchor ? menuAnchor.y : rect.bottom + 3;
        menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - menu.offsetHeight - 8))}px`;
    }

    /** 打开列显示菜单并将焦点移入可操作选项。 */
    function showColumnMenu(anchor) {
        endResize();
        menuAnchor = anchor;
        menuReturnFocus = document.activeElement;
        elements['column-menu'].hidden = false;
        elements['columns-toggle'].setAttribute('aria-expanded', 'true');
        updateColumnOptions();
        positionColumnMenu();
        elements['column-options'].querySelector('input:not(:disabled)')?.focus();
    }

    /** 关闭列显示菜单并按需恢复打开前的键盘焦点。 */
    function closeColumnMenu(restoreFocus = false) {
        if (elements['column-menu'].hidden) {
            return;
        }
        elements['column-menu'].hidden = true;
        elements['columns-toggle'].setAttribute('aria-expanded', 'false');
        if (restoreFocus) {
            const target = menuReturnFocus?.isConnected ? menuReturnFocus : elements['columns-toggle'];
            target.focus({ preventScroll: true });
        }
    }

    /** 同步列菜单勾选状态并保证至少显示一列。 */
    function updateColumnOptions() {
        elements['column-options'].querySelectorAll('input').forEach((input) => {
            input.checked = ui.visibleColumns.includes(input.value);
            input.disabled = input.checked && ui.visibleColumns.length === 1;
        });
    }

    /** 创建供用户勾选显示列的菜单选项。 */
    function createColumnOptions() {
        columns.forEach((column) => {
            const label = document.createElement('label');
            label.className = 'column-option';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = column.key;
            input.addEventListener('change', () => {
                const selected = new Set(ui.visibleColumns);
                if (input.checked) {
                    selected.add(column.key);
                } else if (selected.size > 1) {
                    selected.delete(column.key);
                }
                ui.visibleColumns = columns.filter((entry) => selected.has(entry.key)).map((entry) => entry.key);
                createHeader();
                applyWidths();
                updateColumnOptions();
                saveState();
            });
            label.append(input, document.createTextNode(column.label));
            elements['column-options'].append(label);
        });
        updateColumnOptions();
    }

    /** 应用列宽并同步分隔线的无障碍数值。 */
    function applyWidths(resetHeights = true) {
        const visible = getVisibleColumns();
        document.documentElement.style.setProperty('--columns', visible.map((column) => `${ui.columnWidths[column.key]}px`).join(' '));
        document.documentElement.style.setProperty('--table-width', `${visible.reduce((sum, column) => sum + ui.columnWidths[column.key], 0)}px`);
        elements['table-scroll'].setAttribute('aria-colcount', String(visible.length));
        elements['table-header'].querySelectorAll('.column-resizer').forEach((handle) => handle.setAttribute('aria-valuenow', String(ui.columnWidths[handle.dataset.columnKey])));
        if (resetHeights && ui.wrap) {
            heights.clear();
            buildOffsets();
        }
        scheduleRender();
    }

    /** 创建列标题和可拖动及键盘调整的列宽分隔线。 */
    function createHeader() {
        elements['table-header'].replaceChildren();
        getVisibleColumns().forEach((column) => {
            const cell = document.createElement('div');
            cell.className = 'header-cell';
            cell.setAttribute('role', 'columnheader');
            cell.textContent = column.label;
            const handle = document.createElement('button');
            handle.type = 'button';
            handle.className = 'column-resizer';
            handle.dataset.columnKey = column.key;
            handle.setAttribute('role', 'separator');
            handle.setAttribute('aria-orientation', 'vertical');
            handle.setAttribute('aria-label', `调整${column.label}列宽`);
            handle.setAttribute('aria-valuemin', String(column.min));
            handle.setAttribute('aria-valuemax', '4000');
            handle.title = '左右拖动调整列宽，双击恢复；方向键微调';
            handle.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) {
                    return;
                }
                event.preventDefault();
                closeColumnMenu();
                activeResize = { startX: event.clientX, width: ui.columnWidths[column.key], handle, pointerId: event.pointerId };
                handle.setPointerCapture(event.pointerId);
                document.body.classList.add('resizing');
            });
            handle.addEventListener('pointermove', (event) => {
                if (activeResize?.handle === handle) {
                    ui.columnWidths[column.key] = Math.round(Math.max(column.min, Math.min(4000, activeResize.width + event.clientX - activeResize.startX)));
                    applyWidths();
                }
            });
            handle.addEventListener('pointerup', endResize);
            handle.addEventListener('pointercancel', endResize);
            handle.addEventListener('lostpointercapture', endResize);
            handle.addEventListener('dblclick', () => { ui.columnWidths[column.key] = column.width; applyWidths(); saveState(); });
            handle.addEventListener('keydown', (event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) {
                    return;
                }
                event.preventDefault();
                ui.columnWidths[column.key] = event.key === 'Home' ? column.width : Math.max(column.min, Math.min(4000, ui.columnWidths[column.key] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 30 : 10)));
                applyWidths();
                saveState();
            });
            cell.append(handle);
            elements['table-header'].append(cell);
        });
    }

    /** 结束拖动并保存列宽后应用延迟到达的数据更新。 */
    function endResize() {
        if (!activeResize) {
            return;
        }
        const { handle, pointerId } = activeResize;
        activeResize = undefined;
        document.body.classList.remove('resizing');
        if (handle.hasPointerCapture(pointerId)) {
            handle.releasePointerCapture(pointerId);
        }
        saveState();
        if (pendingSnapshot) {
            const next = pendingSnapshot;
            pendingSnapshot = undefined;
            acceptSnapshot(next);
        }
    }

    /** 按筛选和分组条件建立虚拟列表条目。 */
    function rebuildEntries(resetScroll = false) {
        const query = ui.filter.trim().toLocaleLowerCase();
        filtered = snapshot.items.filter((item) => !query || `${item.text}\n${item.file}\n${item.path}\n${item.workspace}\n${item.member}\n${item.type}`.toLocaleLowerCase().includes(query));
        entries = [];
        if (ui.group === 'flat') {
            entries = filtered.map((item) => ({ kind: 'reference', key: item.id, item }));
        } else {
            const groups = new Map();
            filtered.forEach((item) => {
                const key = ui.group === 'file' ? item.uri : item.workspace;
                if (!groups.has(key)) {
                    groups.set(key, { label: ui.group === 'file' ? item.path : item.workspace, items: [] });
                }
                groups.get(key).items.push(item);
            });
            groups.forEach((group, key) => {
                const groupKey = `${ui.group}:${key}`;
                entries.push({ kind: 'group', key: groupKey, label: group.label, count: group.items.length });
                if (!ui.collapsed.has(groupKey)) {
                    for (const item of group.items) {
                        entries.push({ kind: 'reference', key: item.id, item });
                    }
                }
            });
        }
        let resultIndex = 0;
        for (const entry of entries) {
            if (entry.kind === 'reference') {
                entry.striped = resultIndex++ % 2 === 1;
            }
        }
        const visibleFiles = new Set(filtered.map((item) => item.uri)).size;
        const noun = snapshot.mode === 'text' ? '个匹配行' : '个引用';
        elements.counts.textContent = snapshot.status === 'loading' ? snapshot.message : `${filtered.length} / ${snapshot.items.length} ${noun} · ${visibleFiles} 个文件${snapshot.enriching ? ' · 补充成员中…' : ''}`;
        elements['table-scroll'].setAttribute('aria-rowcount', String(entries.length + 1));
        elements.empty.hidden = entries.length > 0;
        elements.empty.textContent = snapshot.status === 'loading' ? snapshot.message : (snapshot.message || (query ? '没有符合筛选条件的结果。' : '没有查询结果。'));
        if (resetScroll) {
            elements['table-scroll'].scrollTop = 0;
            ui.scrollTop = 0;
        }
        buildOffsets();
        scheduleRender();
    }

    /** 计算包含已测量换行高度的虚拟条目偏移。 */
    function buildOffsets() {
        offsets = [0];
        for (const entry of entries) {
            const height = entry.kind === 'group' || !ui.wrap ? 22 : (heights.get(entry.key) || 22);
            offsets.push(offsets[offsets.length - 1] + height);
        }
        elements['virtual-space'].style.height = `${offsets[offsets.length - 1]}px`;
    }

    /** 使用二分查找定位滚动位置对应的条目。 */
    function indexAt(offset) {
        let low = 0;
        let high = entries.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (offsets[middle + 1] <= offset) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low;
    }

    /** 将频繁滚动和尺寸变化合并到同一绘制帧。 */
    function scheduleRender() {
        if (!renderFrame) {
            renderFrame = requestAnimationFrame(renderRows);
        }
    }

    /** 仅创建可见区域附近的结果行以支持大量引用。 */
    function renderRows() {
        renderFrame = 0;
        const scroll = elements['table-scroll'];
        const top = Math.max(0, scroll.scrollTop - 25);
        const first = Math.max(0, indexAt(top) - 8);
        const last = Math.min(entries.length, indexAt(top + scroll.clientHeight) + 10);
        const fragment = document.createDocumentFragment();
        for (let index = first; index < last; index++) {
            const entry = entries[index];
            const row = document.createElement('div');
            row.dataset.entryIndex = String(index);
            row.setAttribute('role', 'row');
            row.setAttribute('aria-rowindex', String(index + 2));
            if (entry.kind === 'group') {
                row.className = 'group-row';
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'group-button';
                button.dataset.groupKey = entry.key;
                button.setAttribute('aria-expanded', String(!ui.collapsed.has(entry.key)));
                const arrow = document.createElement('span');
                arrow.textContent = ui.collapsed.has(entry.key) ? '▸' : '▾';
                arrow.setAttribute('aria-hidden', 'true');
                const label = document.createElement('span');
                label.className = 'group-label';
                label.textContent = entry.label;
                button.title = entry.label;
                const count = document.createElement('span');
                count.className = 'group-count';
                count.textContent = `(${entry.count})`;
                button.append(arrow, label, count);
                const groupCell = document.createElement('div');
                groupCell.setAttribute('role', 'gridcell');
                groupCell.setAttribute('aria-colspan', String(getVisibleColumns().length));
                groupCell.append(button);
                row.append(groupCell);
            } else {
                const item = entry.item;
                row.className = `reference-row${entry.striped ? ' striped' : ''}${ui.selected === item.id ? ' selected' : ''}`;
                row.dataset.id = item.id;
                row.setAttribute('aria-selected', String(ui.selected === item.id));
                getVisibleColumns().forEach((column) => {
                    const cell = document.createElement('div');
                    cell.className = `cell ${column.key === 'text' ? 'code-cell' : column.key === 'line' ? 'number-cell' : 'metadata-cell'}`;
                    cell.dataset.columnKey = column.key;
                    cell.setAttribute('role', 'gridcell');
                    if (column.key === 'text') {
                        const text = item.text.trimStart();
                        const indentation = item.text.length - text.length;
                        const ranges = item.highlightRanges?.map((range) => ({ start: Math.max(0, range.start - indentation), end: Math.max(0, range.end - indentation) }));
                        window.smartReferenceSyntax.append(cell, text, Math.max(0, item.highlightStart - indentation), Math.max(0, item.highlightEnd - indentation), item.language, item.file, ranges);
                    } else {
                        cell.textContent = String(item[column.key] || '');
                        cell.title = column.key === 'file' ? item.path : cell.textContent;
                    }
                    row.append(cell);
                });
            }
            fragment.append(row);
        }
        elements['visible-rows'].replaceChildren(fragment);
        elements['visible-rows'].style.transform = `translateY(${offsets[first] || 0}px)`;
        if (ui.wrap) {
            let changed = false;
            for (const row of elements['visible-rows'].children) {
                const entry = entries[Number(row.dataset.entryIndex)];
                if (entry.kind === 'reference') {
                    const height = Math.max(22, Math.ceil(row.getBoundingClientRect().height));
                    if (heights.get(entry.key) !== height) {
                        heights.set(entry.key, height);
                        changed = true;
                    }
                }
            }
            if (changed) {
                buildOffsets();
                scheduleRender();
            }
        }
    }

    /** 更新选中引用并按需要定位编辑器或滚动到结果。 */
    function selectItem(item, openEditor = false, reveal = false) {
        ui.selected = item.id;
        elements['selected-path'].textContent = `${item.path}:${item.line}`;
        elements['selected-path'].title = elements['selected-path'].textContent;
        if (reveal) {
            const index = entries.findIndex((entry) => entry.kind === 'reference' && entry.key === item.id);
            if (index >= 0) {
                const scroll = elements['table-scroll'];
                if (offsets[index] < scroll.scrollTop) {
                    scroll.scrollTop = offsets[index];
                } else if (offsets[index + 1] + 25 > scroll.scrollTop + scroll.clientHeight) {
                    scroll.scrollTop = offsets[index + 1] + 25 - scroll.clientHeight;
                }
            }
        }
        if (ui.preview) {
            requestPreview(item);
        }
        if (openEditor) {
            navigate(item, true);
        }
        for (const row of elements['visible-rows'].children) {
            if (row.dataset.id) {
                const selected = row.dataset.id === ui.selected;
                row.classList.toggle('selected', selected);
                row.setAttribute('aria-selected', String(selected));
            }
        }
        scheduleSave();
    }

    /** 请求引用上下文并记录目标以忽略迟到响应。 */
    function requestPreview(item) {
        previewItemId = item.id;
        requestId++;
        elements['preview-title'].textContent = item.path;
        elements['preview-code'].textContent = '读取上下文…';
        vscode.postMessage({ type: 'preview', queryId: snapshot.queryId, id: item.id, requestId });
    }

    /** 将显式请求的上下文以安全文本写入预览侧栏。 */
    function displayPreview(preview) {
        const title = elements['preview-title'];
        const code = elements['preview-code'];
        title.textContent = `${preview.path}:${preview.line}`;
        code.replaceChildren();
        if (preview.error) {
            const error = document.createElement('span');
            error.className = 'preview-error';
            error.textContent = preview.error;
            code.append(error);
        } else {
            for (const line of preview.lines) {
                const row = document.createElement('span');
                row.className = `preview-line${line.number === preview.line ? ' hit' : ''}`;
                const number = document.createElement('span');
                number.className = 'preview-number';
                number.textContent = String(line.number);
                const text = document.createElement('span');
                text.className = 'preview-text';
                window.smartReferenceSyntax.append(text, line.text, line.start, line.end, preview.language, preview.path, line.ranges);
                row.append(number, text);
                code.append(row);
            }
        }
    }

    /** 应用工具栏偏好并更新预览区域的可见性。 */
    function applyPreferences() {
        elements['search-mode'].value = snapshot.mode || 'references';
        elements.filter.value = ui.filter;
        elements.group.value = ui.group;
        elements.wrap.setAttribute('aria-pressed', String(ui.wrap));
        elements['preview-toggle'].setAttribute('aria-pressed', String(ui.preview));
        elements['stripes-toggle'].setAttribute('aria-pressed', String(ui.stripedRows));
        document.body.classList.toggle('wrap', ui.wrap);
        document.body.classList.toggle('striped-rows', ui.stripedRows);
        elements['preview-pane'].hidden = !ui.preview;
        elements.collapse.disabled = ui.group === 'flat';
    }

    /** 接受会话快照并保持筛选和列宽等独立界面状态。 */
    function acceptSnapshot(next) {
        if (next.queryId < snapshot.queryId) {
            return;
        }
        if (activeResize) {
            pendingSnapshot = next;
            return;
        }
        const newQuery = next.queryId !== snapshot.queryId;
        const firstSnapshot = snapshot.queryId === -1;
        snapshot = next;
        const isText = next.mode === 'text';
        elements['query-title'].textContent = next.label ? `“${next.label}”的${isText ? '文本匹配' : '引用'}` : '智能引用';
        elements['query-title'].title = next.source ? `${next.source} · ${next.label}` : '智能引用';
        elements['search-mode'].title = isText ? '搜索源码字面文本，包含同名符号、注释和字符串；不补充类型或成员。' : '通过语言服务查找真实符号引用。';
        elements['table-scroll'].setAttribute('aria-label', isText ? '文本匹配结果' : '引用结果');
        elements.refresh.disabled = !next.label || next.status === 'loading';
        elements.cancel.hidden = next.status !== 'loading' && !next.enriching;
        const warnings = [...(next.stale ? [isText ? '文件已修改，文本匹配结果可能过期，请重新搜索。' : '文件已修改，结果可能过期。请重新查询；查询起点有修改时请从编辑器重新执行查找。'] : []), ...(next.warnings.length ? [next.warnings[0], ...(next.warnings.length > 1 ? [`另有 ${next.warnings.length - 1} 项搜索提示，悬停查看详情。`] : [])] : [])];
        elements.banner.hidden = warnings.length === 0;
        elements.banner.textContent = warnings.join(' ');
        elements.banner.title = next.warnings.join('\n');
        if (newQuery) {
            heights.clear();
            requestId++;
            elements['preview-code'].textContent = '';
            elements['preview-title'].textContent = '引用上下文';
            if (!firstSnapshot) {
                ui.selected = '';
                ui.collapsed.clear();
            }
        }
        rebuildEntries(newQuery && !firstSnapshot);
        if (restoring) {
            elements['table-scroll'].scrollTop = ui.scrollTop;
            elements['table-scroll'].scrollLeft = ui.scrollLeft;
            restoring = false;
        }
        const selected = next.items.find((item) => item.id === ui.selected);
        if (selected) {
            elements['selected-path'].textContent = `${selected.path}:${selected.line}`;
            if (ui.preview && (newQuery || firstSnapshot)) {
                requestPreview(selected);
            }
        } else {
            elements['selected-path'].textContent = '完整代码行 · 拖动表头分隔线调整列宽';
        }
        applyPreferences();
    }

    elements.refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    elements['search-mode'].addEventListener('change', () => vscode.postMessage({ type: 'mode', mode: elements['search-mode'].value }));
    elements.cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    elements.clear.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
    elements.filter.addEventListener('input', () => {
        ui.filter = elements.filter.value;
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => { rebuildEntries(true); saveState(); }, 100);
    });
    elements.group.addEventListener('change', () => { ui.group = elements.group.value; applyPreferences(); rebuildEntries(true); saveState(); });
    elements.collapse.addEventListener('click', () => {
        const groupKeys = entries.filter((entry) => entry.kind === 'group').map((entry) => entry.key);
        const allCollapsed = groupKeys.length > 0 && groupKeys.every((key) => ui.collapsed.has(key));
        groupKeys.forEach((key) => allCollapsed ? ui.collapsed.delete(key) : ui.collapsed.add(key));
        elements.collapse.textContent = allCollapsed ? '折叠' : '展开';
        rebuildEntries(true);
        saveState();
    });
    elements.wrap.addEventListener('click', () => { ui.wrap = !ui.wrap; heights.clear(); applyPreferences(); buildOffsets(); scheduleRender(); saveState(); });
    elements['stripes-toggle'].addEventListener('click', () => { ui.stripedRows = !ui.stripedRows; applyPreferences(); saveState(); });
    elements['preview-toggle'].addEventListener('click', () => {
        ui.preview = !ui.preview;
        requestId++;
        applyPreferences();
        const selected = snapshot.items.find((item) => item.id === ui.selected) || filtered[0];
        if (ui.preview && selected) {
            selectItem(selected);
        }
        saveState();
    });
    elements['table-scroll'].addEventListener('scroll', () => {
        ui.scrollTop = elements['table-scroll'].scrollTop;
        ui.scrollLeft = elements['table-scroll'].scrollLeft;
        scheduleRender();
        scheduleSave();
    }, { passive: true });
    elements['visible-rows'].addEventListener('click', (event) => {
        const group = event.target.closest('[data-group-key]');
        if (group) {
            const key = group.dataset.groupKey;
            ui.collapsed.has(key) ? ui.collapsed.delete(key) : ui.collapsed.add(key);
            rebuildEntries();
            saveState();
            return;
        }
        const row = event.target.closest('[data-id]');
        const item = row && snapshot.items.find((entry) => entry.id === row.dataset.id);
        if (item) {
            elements['table-scroll'].focus({ preventScroll: true });
            selectItem(item, true);
        }
    });
    elements['visible-rows'].addEventListener('dblclick', (event) => {
        const row = event.target.closest('[data-id]');
        const item = row && snapshot.items.find((entry) => entry.id === row.dataset.id);
        if (item) {
            navigate(item, false);
        }
    });
    elements['table-scroll'].addEventListener('keydown', (event) => {
        if (event.target.closest('button')) {
            return;
        }
        const visible = entries.filter((entry) => entry.kind === 'reference').map((entry) => entry.item);
        const index = visible.findIndex((item) => item.id === ui.selected);
        if (event.key === 'Enter' && index >= 0) {
            event.preventDefault();
            navigate(visible[index], false);
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && visible.length) {
            event.preventDefault();
            const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
            selectItem(visible[nextIndex], true, true);
        }
    });
    elements['columns-toggle'].addEventListener('click', () => {
        if (elements['column-menu'].hidden) {
            showColumnMenu();
        } else {
            closeColumnMenu(true);
        }
    });
    elements['table-header'].addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showColumnMenu({ x: event.clientX, y: event.clientY });
    });
    elements['columns-reset'].addEventListener('click', () => {
        ui.visibleColumns = columns.map((column) => column.key);
        ui.columnWidths = Object.fromEntries(columns.map((column) => [column.key, column.width]));
        createHeader();
        applyWidths();
        updateColumnOptions();
        saveState();
    });
    document.addEventListener('pointerdown', (event) => {
        if (!elements['column-menu'].contains(event.target) && !elements['columns-toggle'].contains(event.target)) {
            closeColumnMenu();
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !elements['column-menu'].hidden) {
            event.preventDefault();
            closeColumnMenu(true);
        }
    });
    window.addEventListener('blur', () => { endResize(); closeColumnMenu(); saveState(); });
    window.addEventListener('pagehide', saveState);
    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message?.type === 'snapshot') {
            acceptSnapshot(message.snapshot);
        } else if (message?.type === 'preview' && message.queryId === snapshot.queryId && message.requestId === requestId && message.id === previewItemId && ui.preview) {
            displayPreview(message.preview);
        }
    });
    new ResizeObserver(() => {
        if (!elements['column-menu'].hidden) {
            positionColumnMenu();
        }
        scheduleRender();
    }).observe(elements['table-scroll']);
    createHeader();
    createColumnOptions();
    applyPreferences();
    applyWidths(false);
    vscode.postMessage({ type: 'ready' });
})();
