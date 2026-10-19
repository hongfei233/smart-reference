import * as vscode from 'vscode';
import { ReferencePreview, ReferenceRecord, ReferenceSearchMode, ReferenceSnapshot, ReferenceTarget } from '../models/referenceModels';
import { createRecord, documentFingerprint, documentMatches, enrichRecord, normalizeLocations, runLimited, textFingerprint } from './referenceService';
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
        const watcher: vscode.FileSystemWatcher = vscode.workspace.createFileSystemWatcher('**/*', true, false, false);
        this.subscriptions.push(
            watcher,
            watcher.onDidChange((uri: vscode.Uri): void => {
                if (this.containsUri(uri)) {
                    this.markStale();
                }
            }),
            watcher.onDidDelete((uri: vscode.Uri): void => {
                if (this.containsUri(uri, true)) {
                    this.markStale();
                }
            }),
            vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent): void => {
                if (event.contentChanges.length > 0 && (this.snapshot.status === 'loading' || this.containsUri(event.document.uri))) {
                    this.markStale();
                }
            }),
            vscode.workspace.onDidRenameFiles((event: vscode.FileRenameEvent): void => {
                if (event.files.some((file): boolean => this.containsUri(file.oldUri, true))) {
                    this.markStale();
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
    public async search(target: ReferenceTarget, mode: ReferenceSearchMode = 'references'): Promise<void> {
        this.stopTextSearch();
        const queryId: number = this.snapshot.queryId + 1;
        this.navigationId++;
        this.target = target;
        this.records.clear();
        this.referencedUris.clear();
        this.referencedUris.add(target.uri.toString());
        this.snapshot = {
            queryId, mode, status: 'loading', label: target.label, source: vscode.workspace.asRelativePath(target.uri, true),
            items: [], stale: false, message: mode === 'text' ? '正在枚举工作区源码…' : '正在查询语言服务…', warnings: [], enriching: false
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
                    fileRecords.set(key, loaded);
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
            this.snapshot.items = Array.from(this.records.values()).map((record: ReferenceRecord) => record.item)
                .sort((left, right): number => left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column);
            this.snapshot.status = 'ready';
            this.snapshot.message = this.snapshot.items.length > 0 ? '' : '未找到引用。请确认光标位于符号上，且语言服务和项目已加载。';
            this.snapshot.enriching = fileRecords.size > 0;
            this.publish();
            await runLimited(Array.from(fileRecords.entries()), 2, current, async ([key, records]): Promise<void> => {
                try {
                    const symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', vscode.Uri.parse(key));
                    if (!current()) {
                        return;
                    }
                    for (const record of records) {
                        enrichRecord(record, symbols ?? []);
                    }
                    this.publishLater();
                } catch {
                    // 所属成员属于可选信息，语言服务不支持时保留基础引用结果。
                }
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
    public async refresh(mode: ReferenceSearchMode = this.snapshot.mode): Promise<void> {
        if (!this.target) {
            return;
        }
        const target: ReferenceTarget = this.target;
        if (mode === 'text') {
            await this.search(target, mode);
            return;
        }
        const queryId: number = this.snapshot.queryId;
        try {
            const document: vscode.TextDocument = await vscode.workspace.openTextDocument(target.uri);
            if (this.disposed || this.target !== target || this.snapshot.queryId !== queryId) {
                return;
            }
            if (!documentMatches(document, target)) {
                this.markStale();
                void vscode.window.showWarningMessage('查询起点所在文件已更改，请将光标放回符号上重新执行“查找智能引用”。');
                this.publish();
                return;
            }
            await this.search({ ...target, document, version: document.version }, mode);
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
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        this.emitter.dispose();
    }

    /** 扫描源码文本并逐批发布匹配行而不调用引用和文档符号提供器。 */
    private async searchText(target: ReferenceTarget, current: () => boolean): Promise<void> {
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
