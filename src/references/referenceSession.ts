import * as vscode from 'vscode';
import { ReferencePreview, ReferenceRecord, ReferenceSearchMode, ReferenceSnapshot, ReferenceTarget } from '../models/referenceModels';
import { createRecord, documentFingerprint, documentMatches, enrichAccess, enrichCSharpAccess, enrichRecord, normalizeLocations, runLimited, textFingerprint, trackRange } from './referenceService';
import { readTextSource, searchTextMatches, TextSearchSummary, TextSource } from './textSearchService';

/** 管理引用查询、文档失效和异步结果的生命周期。 */
export class ReferenceSession implements vscode.Disposable {
    private readonly emitter: vscode.EventEmitter<ReferenceSnapshot> = new vscode.EventEmitter<ReferenceSnapshot>();
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly records: Map<string, ReferenceRecord> = new Map();
    private target: ReferenceTarget | undefined;
    private disposed: boolean = false;
    private navigationId: number = 0;
    private navigationQueue: Promise<void> = Promise.resolve();
    private readonly referencedUris: Set<string> = new Set();
    private updateTimer: ReturnType<typeof setTimeout> | undefined;
    private textCancellation: vscode.CancellationTokenSource | undefined;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private targetRange: vscode.Range | undefined;
    private targetInvalid: boolean = false;
    public readonly onDidChange: vscode.Event<ReferenceSnapshot> = this.emitter.event;
    public snapshot: ReferenceSnapshot = {
        queryId: 0, mode: 'references', status: 'idle', label: '', source: '', items: [], stale: false,
        message: '在编辑器中右键选择“查找智能引用”，或连续按两次 Shift+F12。', warnings: [], enriching: false
    };

    /** 订阅可能使引用位置过期的文档和文件事件。 */
    public constructor(private readonly workspaceState?: vscode.Memento) {
        this.snapshot.mode = workspaceState?.get<string>('smart-reference.searchMode') === 'text' ? 'text' : 'references';
        if (this.snapshot.mode === 'text') {
            this.snapshot.message = '在编辑器中选中文本或将光标放到单词上，执行“快速浏览匹配”。';
        }
        const watcher: vscode.FileSystemWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false);
        this.subscriptions.push(
            watcher,
            watcher.onDidCreate((uri: vscode.Uri): void => this.scheduleRefresh(uri)),
            watcher.onDidChange((uri: vscode.Uri): void => {
                if (this.containsUri(uri)) {
                    this.markStale();
                }
                this.scheduleRefresh(uri);
            }),
            watcher.onDidDelete((uri: vscode.Uri): void => {
                if (this.containsUri(uri, true)) {
                    this.markStale();
                }
                if (this.target?.uri.toString() === uri.toString()) {
                    this.targetInvalid = true;
                }
                this.scheduleRefresh(uri);
            }),
            vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent): void => {
                if (event.contentChanges.length > 0) {
                    this.trackDocument(event);
                }
            }),
            vscode.workspace.onDidOpenTextDocument((document: vscode.TextDocument): void => {
                for (const record of this.records.values()) {
                    if (record.item.uri === document.uri.toString() && documentMatches(document, record)) {
                        record.document = document;
                        record.version = document.version;
                    }
                }
                if (this.target?.uri.toString() === document.uri.toString() && documentMatches(document, this.target)) {
                    this.target.document = document;
                    this.target.version = document.version;
                }
            }),
            vscode.workspace.onDidSaveTextDocument((document: vscode.TextDocument): void => this.scheduleRefresh(document.uri, true)),
            vscode.workspace.onDidRenameFiles((event: vscode.FileRenameEvent): void => {
                if (event.files.some((file): boolean => this.containsUri(file.oldUri, true))) {
                    this.markStale();
                }
                if (this.target && event.files.some((file): boolean => this.target!.uri.toString().startsWith(file.oldUri.toString()))) {
                    this.targetInvalid = true;
                }
                for (const file of event.files) {
                    this.scheduleRefresh(file.newUri, true);
                }
            }),
            vscode.workspace.onDidDeleteFiles((event: vscode.FileDeleteEvent): void => {
                if (event.files.some((uri: vscode.Uri): boolean => this.containsUri(uri, true))) {
                    this.markStale();
                }
            })
        );
    }

    /** 查询指定符号的引用并分阶段补充所属成员信息。 */
    public async search(target: ReferenceTarget, mode: ReferenceSearchMode = 'references', preserveView: boolean = false): Promise<void> {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
        this.stopTextSearch();
        const queryId: number = this.snapshot.queryId + 1;
        this.navigationId++;
        this.target = target;
        this.targetRange = target.document.getWordRangeAtPosition(target.document.validatePosition(target.position));
        this.targetInvalid = false;
        this.records.clear();
        this.referencedUris.clear();
        this.referencedUris.add(target.uri.toString());
        this.snapshot = {
            queryId, mode, status: 'loading', label: target.label, source: vscode.workspace.asRelativePath(target.uri, true),
            items: preserveView ? this.snapshot.items : [], stale: false, preserveView,
            message: mode === 'text' ? '正在枚举工作区源码…' : '正在查询语言服务…', warnings: [], enriching: false
        };
        this.saveMode(mode);
        this.publish();
        const current: () => boolean = (): boolean => !this.disposed && this.snapshot.queryId === queryId;
        try {
            if (mode === 'text') {
                await this.searchText(target, current);
                return;
            }
            const provided: vscode.Location[] | undefined = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', target.uri, target.position);
            if (!current()) {
                return;
            }
            const locations: vscode.Location[] = normalizeLocations(provided ?? []);
            const files: Map<string, vscode.Location[]> = new Map();
            for (const location of locations) {
                const key: string = location.uri.toString();
                this.referencedUris.add(key);
                const entries: vscode.Location[] = files.get(key) ?? [];
                entries.push(location);
                files.set(key, entries);
            }
            let completed: number = 0;
            const fileRecords: Map<string, ReferenceRecord[]> = new Map();
            await runLimited(Array.from(files.entries()), 4, current, async ([key, entries]): Promise<void> => {
                try {
                    const document: vscode.TextDocument = await vscode.workspace.openTextDocument(entries[0].uri);
                    if (!current()) {
                        return;
                    }
                    const loaded: ReferenceRecord[] = [];
                    const hash: string = documentFingerprint(document);
                    for (const location of entries) {
                        try {
                            const record: ReferenceRecord = createRecord(document, location, `${key}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`, hash);
                            this.records.set(record.item.id, record);
                            loaded.push(record);
                        } catch {
                            this.snapshot.warnings.push(`${vscode.workspace.asRelativePath(location.uri, true)}：引用位置已失效`);
                            this.snapshot.stale = true;
                        }
                    }
                    if (loaded.length > 0) {
                        fileRecords.set(key, loaded);
                    }
                } catch (error: unknown) {
                    if (current()) {
                        this.snapshot.warnings.push(`${vscode.workspace.asRelativePath(entries[0].uri, true)}：${this.errorText(error)}`);
                    }
                }
                if (current()) {
                    completed++;
                    this.snapshot.message = `正在读取代码 ${completed}/${files.size} 个文件…`;
                    this.publishLater();
                }
            });
            if (!current()) {
                return;
            }
            const records: ReferenceRecord[] = Array.from(this.records.values());
            enrichCSharpAccess(records);
            this.snapshot.items = records.map((record: ReferenceRecord) => record.item)
                .sort((left, right): number => left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column);
            this.snapshot.status = 'ready';
            this.snapshot.message = this.snapshot.items.length > 0 ? '' : '未找到引用。请确认光标位于符号上，且语言服务和项目已加载。';
            this.snapshot.enriching = fileRecords.size > 0;
            this.publish();
            await runLimited(Array.from(fileRecords.values()), 2, current, async (records): Promise<void> => {
                const first: ReferenceRecord = records[0];
                const { uri, range } = first.location;
                const [symbols, highlights] = await Promise.allSettled([
                    vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri),
                    vscode.commands.executeCommand<vscode.DocumentHighlight[]>('vscode.executeDocumentHighlights', uri, range.start)
                ]);
                if (!current() || first.document?.version !== first.version) {
                    return;
                }
                if (symbols.status === 'fulfilled') {
                    for (const record of records) {
                        enrichRecord(record, symbols.value ?? []);
                    }
                }
                if (highlights.status === 'fulfilled') {
                    enrichAccess(records, highlights.value ?? []);
                }
                this.publishLater();
            });
            if (current()) {
                this.snapshot.enriching = false;
                this.publish();
            }
        } catch (error: unknown) {
            if (current()) {
                this.snapshot.status = 'error';
                this.snapshot.message = `${mode === 'text' ? '文本搜索' : '引用查询'}失败：${this.errorText(error)}`;
                this.snapshot.enriching = false;
                this.publish();
            }
        }
    }

    /** 使用保存的符号位置重新查询并阻止使用已经修改的查询起点。 */
    public async refresh(mode: ReferenceSearchMode = this.snapshot.mode, preserveView: boolean = false): Promise<void> {
        if (!this.target) {
            return;
        }
        const target: ReferenceTarget = this.target;
        if (mode === 'text') {
            await this.search(target, mode, preserveView);
            return;
        }
        const queryId: number = this.snapshot.queryId;
        try {
            const document: vscode.TextDocument = await vscode.workspace.openTextDocument(target.uri);
            if (this.disposed || this.target !== target || this.snapshot.queryId !== queryId) {
                return;
            }
            if (this.targetInvalid || !documentMatches(document, target)) {
                this.markStale();
                void vscode.window.showWarningMessage('查询起点所在文件已更改，请将光标放回符号上重新执行“查找智能引用”。');
                this.publish();
                return;
            }
            await this.search({ ...target, document, version: document.version }, mode, preserveView);
        } catch (error: unknown) {
            void vscode.window.showWarningMessage(`无法重新查询：${this.errorText(error)}`);
            this.publish();
        }
    }

    /** 切换搜索模式并使用原始查询文本重新查询。 */
    public async changeMode(mode: ReferenceSearchMode): Promise<void> {
        if (this.target) {
            await this.refresh(mode);
        } else {
            this.snapshot.mode = mode;
            this.snapshot.message = mode === 'text' ? '在编辑器中选中文本或将光标放到单词上，执行“快速浏览匹配”。' : '将光标放到符号上，执行“查找智能引用”。';
            this.saveMode(mode);
            this.publish();
        }
    }

    /** 取消当前查询并丢弃后续到达的语言服务结果。 */
    public cancel(): void {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
        this.stopTextSearch();
        this.snapshot.queryId++;
        this.navigationId++;
        this.snapshot.status = this.snapshot.items.length > 0 ? 'ready' : 'idle';
        this.snapshot.message = this.snapshot.mode === 'text' && this.snapshot.items.length > 0 ? '搜索已取消，保留已加载的匹配行。' : '查询已取消。';
        this.snapshot.enriching = false;
        this.publish();
    }

    /** 清空当前结果并使尚未结束的查询失效。 */
    public clear(): void {
        this.cancel();
        this.target = undefined;
        this.records.clear();
        this.referencedUris.clear();
        this.snapshot = { ...this.snapshot, status: 'idle', label: '', source: '', items: [], stale: false, warnings: [], message: this.snapshot.mode === 'text' ? '在编辑器中选中文本或将光标放到单词上，执行“快速浏览匹配”。' : '将光标放到符号上，执行“查找智能引用”。' };
        this.publish();
    }

    /** 在编辑器中预览或正式打开指定引用。 */
    public async navigate(queryId: number, id: string, preview: boolean): Promise<void> {
        const record: ReferenceRecord | undefined = this.getRecord(queryId, id);
        if (!record) {
            return;
        }
        const navigationId: number = ++this.navigationId;
        this.navigationQueue = this.navigationQueue.then(async (): Promise<void> => {
            try {
                if (navigationId !== this.navigationId || !this.getRecord(queryId, id)) {
                    return;
                }
                const document: vscode.TextDocument = await vscode.workspace.openTextDocument(record.location.uri);
                if (navigationId !== this.navigationId || !this.getRecord(queryId, id)) {
                    return;
                }
                if (!documentMatches(document, record)) {
                    this.markStale();
                    void vscode.window.showWarningMessage('该引用所在文件已更改，请重新查询后再跳转。');
                    return;
                }
                const editor: vscode.TextEditor = await vscode.window.showTextDocument(document, {
                    viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
                    selection: record.location.range, preserveFocus: preview, preview
                });
                if (navigationId === this.navigationId && this.getRecord(queryId, id)) {
                    editor.revealRange(record.location.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                }
            } catch (error: unknown) {
                void vscode.window.showWarningMessage(`无法打开引用：${this.errorText(error)}`);
            }
        });
        await this.navigationQueue;
    }

    /** 读取指定引用前后各三行的代码并验证原始文档版本。 */
    public async preview(queryId: number, id: string): Promise<ReferencePreview | undefined> {
        const record: ReferenceRecord | undefined = this.getRecord(queryId, id);
        if (!record) {
            return undefined;
        }
        try {
            if (record.normalizeLineEndings) {
                return await this.previewTextRecord(queryId, id, record);
            }
            const document: vscode.TextDocument = await vscode.workspace.openTextDocument(record.location.uri);
            if (!this.getRecord(queryId, id)) {
                return undefined;
            }
            if (!documentMatches(document, record)) {
                this.markStale();
                return { path: record.item.path, line: record.item.line, lines: [], error: '文件已更改，请重新查询引用。' };
            }
            const lines: ReferencePreview['lines'] = [];
            for (let index: number = Math.max(0, record.item.line - 4); index < Math.min(document.lineCount, record.item.line + 3); index++) {
                const text: string = document.lineAt(index).text;
                const hit: boolean = index === record.item.line - 1;
                lines.push({ number: index + 1, text, start: hit ? record.item.highlightStart : -1, end: hit ? record.item.highlightEnd : -1 });
            }
            return { path: record.item.path, line: record.item.line, language: document.languageId, lines };
        } catch (error: unknown) {
            return { path: record.item.path, line: record.item.line, lines: [], error: this.errorText(error) };
        }
    }

    /** 释放事件订阅并阻止异步查询继续更新界面。 */
    public dispose(): void {
        this.disposed = true;
        this.stopTextSearch();
        clearTimeout(this.updateTimer);
        clearTimeout(this.refreshTimer);
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        this.emitter.dispose();
    }

    /** 扫描源码文本并逐批发布匹配行而不调用引用和文档符号提供器。 */
    private async searchText(target: ReferenceTarget, current: () => boolean): Promise<void> {
        this.snapshot.items = [];
        const cancellation: vscode.CancellationTokenSource = new vscode.CancellationTokenSource();
        this.textCancellation = cancellation;
        try {
            const result: TextSearchSummary = await searchTextMatches(target.label, target.uri, current, cancellation.token,
                (records: ReferenceRecord[]): void => {
                    if (!current()) {
                        return;
                    }
                    for (const record of records) {
                        this.records.set(record.item.id, record);
                        this.referencedUris.add(record.item.uri);
                        this.snapshot.items.push(record.item);
                    }
                    this.publishLater();
                },
                (scanned: number, total: number): void => {
                    if (current()) {
                        this.snapshot.message = `已扫描 ${scanned}/${total} 个文件 · ${this.snapshot.items.length} 个匹配行`;
                        this.publishLater();
                    }
                });
            if (current()) {
                this.snapshot.status = 'ready';
                this.snapshot.warnings = result.warnings;
                this.snapshot.message = this.snapshot.items.length > 0 ? '' : '未找到匹配文本，可检查大小写及快速搜索的包含、排除设置。';
                this.publish();
            }
        } finally {
            if (this.textCancellation === cancellation) {
                this.textCancellation = undefined;
                cancellation.dispose();
            }
        }
    }

    /** 直接读取文本匹配的上下文并验证文件内容后合并该行全部命中标记。 */
    private async previewTextRecord(queryId: number, id: string, record: ReferenceRecord): Promise<ReferencePreview | undefined> {
        if (record.invalid) {
            return { path: record.item.path, line: record.item.line, lines: [], error: '引用已修改，请保存后等待刷新。' };
        }
        const source: TextSource = await readTextSource(record.location.uri, 32 * 1024 * 1024);
        if (!this.getRecord(queryId, id)) {
            return undefined;
        }
        if (textFingerprint(source.text, true) !== record.documentHash) {
            this.markStale();
            return { path: record.item.path, line: record.item.line, lines: [], error: '文件已更改，请重新搜索。' };
        }
        const texts: string[] = source.text.split(/\r\n|\n|\r/);
        const lines: ReferencePreview['lines'] = [];
        for (let index: number = Math.max(0, record.item.line - 4); index < Math.min(texts.length, record.item.line + 3); index++) {
            const hit: boolean = index === record.item.line - 1;
            lines.push({ number: index + 1, text: texts[index], start: hit ? record.item.highlightStart : -1, end: hit ? record.item.highlightEnd : -1, ranges: hit ? record.item.highlightRanges : undefined });
        }
        return { path: record.item.path, line: record.item.line, language: source.language, lines };
    }

    /** 取消文件枚举并阻止快速搜索继续分配读取任务。 */
    private stopTextSearch(): void {
        this.textCancellation?.cancel();
        this.textCancellation?.dispose();
        this.textCancellation = undefined;
    }

    /** 保存工作区搜索模式且不改写用户配置文件。 */
    private saveMode(mode: ReferenceSearchMode): void {
        void this.workspaceState?.update('smart-reference.searchMode', mode).then(undefined, (): void => {});
    }

    /** 根据文本编辑同步查询起点及未被覆盖的引用位置。 */
    private trackDocument(event: vscode.TextDocumentChangeEvent): void {
        if (!this.target || !vscode.workspace.getWorkspaceFolder(event.document.uri)) {
            return;
        }
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
        if (this.snapshot.status === 'loading' || this.snapshot.enriching) {
            this.stopTextSearch();
            this.snapshot.queryId++;
            this.snapshot.preserveView = true;
            this.snapshot.status = 'ready';
            this.snapshot.enriching = false;
            this.snapshot.items = Array.from(this.records.values()).map((record): ReferenceRecord['item'] => record.item);
        }
        this.navigationId++;
        const document: vscode.TextDocument = event.document;
        const hash: string = documentFingerprint(document);
        const normalizedHash: string = textFingerprint(document.getText(), true);
        if (this.target.uri.toString() === document.uri.toString()) {
            const mapped: vscode.Range | undefined = this.targetRange ? trackRange(this.targetRange, event.contentChanges) : undefined;
            const word: vscode.Range | undefined = mapped ? document.getWordRangeAtPosition(mapped.start) : undefined;
            if (!this.targetInvalid && mapped && this.target.document === document && this.target.version === document.version - 1
                && word && word.start.compareTo(mapped.start) === 0 && word.end.compareTo(mapped.end) === 0
                && document.getText(mapped) === this.target.label) {
                this.targetRange = mapped;
                this.target = { ...this.target, position: mapped.start, version: document.version, documentHash: hash };
            } else {
                this.targetInvalid = true;
            }
        }
        for (const record of this.records.values()) {
            if (record.item.uri !== document.uri.toString() || record.invalid) {
                continue;
            }
            record.item.access = undefined;
            const originalRanges: vscode.Range[] = (record.item.highlightRanges ?? [{ start: record.item.highlightStart, end: record.item.highlightEnd }])
                .map((range): vscode.Range => new vscode.Range(record.item.line - 1, range.start, record.item.line - 1, range.end));
            const mappedRanges: (vscode.Range | undefined)[] = originalRanges.map((range): vscode.Range | undefined => trackRange(range, event.contentChanges));
            const valid: boolean = record.document === document && record.version === document.version - 1
                && mappedRanges.every((range, index): boolean => {
                    if (!range || range.start.line !== mappedRanges[0]?.start.line
                        || document.getText(range) !== record.item.text.slice(originalRanges[index].start.character, originalRanges[index].end.character)) {
                        return false;
                    }
                    const word: vscode.Range | undefined = document.getWordRangeAtPosition(range.start);
                    return this.snapshot.mode === 'text' || !word || (word.start.compareTo(range.start) === 0 && word.end.compareTo(range.end) === 0);
                });
            if (!valid) {
                record.invalid = true;
                continue;
            }
            const ranges: vscode.Range[] = mappedRanges as vscode.Range[];
            const updated: ReferenceRecord = createRecord(document, new vscode.Location(document.uri, ranges[0]), record.item.id,
                record.normalizeLineEndings ? normalizedHash : hash);
            if (record.item.highlightRanges) {
                updated.item.highlightRanges = ranges.map((range): { start: number; end: number } => ({ start: range.start.character, end: range.end.character }));
            }
            Object.assign(record.item, updated.item);
            record.location = updated.location;
            record.document = document;
            record.version = document.version;
            record.documentHash = updated.documentHash;
        }
        this.snapshot.stale = true;
        this.snapshot.message = this.targetInvalid && this.snapshot.mode === 'references'
            ? '查询符号已修改或删除，请在编辑器中重新选择符号查找。'
            : '已同步未受影响的引用位置，保存后将自动刷新结果。';
        this.publish();
    }

    /** 合并源码保存与磁盘变更并重新查询当前结果。 */
    private scheduleRefresh(uri: vscode.Uri, saved: boolean = false): void {
        if (!this.target || this.disposed || !vscode.workspace.getWorkspaceFolder(uri)) {
            return;
        }
        const extension: string = this.target.uri.path.match(/\.[^/.]+$/)?.[0] ?? '';
        if (!saved && !this.containsUri(uri) && (!extension || !uri.path.endsWith(extension))) {
            return;
        }
        if (/(?:^|\/)(?:\.git|node_modules|Library|Temp|Logs|obj|bin|out|dist)(?:\/|$)/i.test(uri.path)
            || vscode.workspace.textDocuments.some((document): boolean => document.uri.toString() === uri.toString() && document.isDirty)) {
            return;
        }
        if (this.snapshot.status === 'loading' || this.snapshot.enriching) {
            this.cancel();
            this.snapshot.preserveView = true;
        }
        this.markStale();
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout((): void => {
            this.refreshTimer = undefined;
            if (this.targetInvalid && this.snapshot.mode === 'references') {
                this.snapshot.message = '查询符号已修改或删除，请在编辑器中重新选择符号查找。';
                this.publish();
                return;
            }
            void this.refresh(this.snapshot.mode, true);
        }, 600);
    }

    /** 返回属于当前查询的可信引用记录。 */
    private getRecord(queryId: number, id: string): ReferenceRecord | undefined {
        return !this.disposed && queryId === this.snapshot.queryId ? this.records.get(id) : undefined;
    }

    /** 判断文件或目录是否包含查询起点或任意引用。 */
    private containsUri(uri: vscode.Uri, descendants: boolean = false): boolean {
        const key: string = uri.toString();
        const matches: (candidate: string) => boolean = (candidate: string): boolean => candidate === key || (descendants && candidate.startsWith(`${key.replace(/\/$/, '')}/`));
        return descendants ? Array.from(this.referencedUris).some(matches) : this.referencedUris.has(key);
    }

    /** 标记当前结果过期并通知界面显示重新查询提示。 */
    private markStale(): void {
        if (!this.snapshot.stale && this.target) {
            this.snapshot.stale = true;
            this.publish();
        }
    }

    /** 合并频繁的读取进度和符号补全更新。 */
    private publishLater(): void {
        if (!this.updateTimer) {
            this.updateTimer = setTimeout((): void => {
                this.updateTimer = undefined;
                this.publish();
            }, 100);
        }
    }

    /** 立即发布当前状态并清理尚未发送的合并更新。 */
    private publish(): void {
        clearTimeout(this.updateTimer);
        this.updateTimer = undefined;
        if (!this.disposed) {
            this.emitter.fire(this.snapshot);
        }
    }

    /** 将未知异常转换成可展示的错误信息。 */
    private errorText(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
