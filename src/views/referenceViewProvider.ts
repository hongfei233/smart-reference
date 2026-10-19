import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ReferencePreview } from '../models/referenceModels';
import { ReferenceSession } from '../references/referenceSession';

/** 在底部面板托管智能引用界面并验证来自界面的操作消息。 */
export class ReferenceViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewId: string = 'smart-reference.results';
    private view: vscode.WebviewView | undefined;
    private readonly subscriptions: vscode.Disposable[] = [];
    private viewSubscriptions: vscode.Disposable[] = [];

    /** 保存扩展资源位置并订阅引用状态更新。 */
    public constructor(private readonly extensionUri: vscode.Uri, private readonly session: ReferenceSession) {
        this.subscriptions.push(session.onDidChange((): void => this.sendSnapshot()));
    }

    /** 创建安全的底部视图并绑定消息和可见性事件。 */
    public resolveWebviewView(view: vscode.WebviewView): void {
        this.disposeViewSubscriptions();
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
        view.webview.html = this.createHtml(view.webview);
        this.viewSubscriptions.push(
            view.webview.onDidReceiveMessage((message: unknown): void => { void this.receiveMessage(message); }),
            view.onDidChangeVisibility((): void => this.sendSnapshot()),
            view.onDidDispose((): void => { this.view = undefined; this.disposeViewSubscriptions(); })
        );
    }

    /** 显示智能引用视图并沿用用户保存的面板布局。 */
    public async show(): Promise<void> {
        await vscode.commands.executeCommand(`${ReferenceViewProvider.viewId}.focus`);
    }

    /** 释放视图事件和会话事件订阅。 */
    public dispose(): void {
        this.disposeViewSubscriptions();
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        this.view = undefined;
    }

    /** 仅向可见视图发送最新快照以支持隐藏后的重新创建。 */
    private sendSnapshot(): void {
        if (this.view?.visible) {
            this.view.description = this.session.snapshot.label;
            void this.view.webview.postMessage({ type: 'snapshot', snapshot: this.session.snapshot });
        }
    }

    /** 验证消息结构并通过可信引用标识处理查询和导航。 */
    private async receiveMessage(value: unknown): Promise<void> {
        if (typeof value !== 'object' || value === null || !('type' in value)) {
            return;
        }
        const message: Record<string, unknown> = value as Record<string, unknown>;
        switch (message.type) {
            case 'ready':
                this.sendSnapshot();
                return;
            case 'refresh':
                await this.session.refresh();
                return;
            case 'mode':
                if (message.mode === 'references' || message.mode === 'text') {
                    await this.session.changeMode(message.mode);
                }
                return;
            case 'clear':
                this.session.clear();
                return;
            case 'cancel':
                this.session.cancel();
                return;
            case 'navigate':
                if (typeof message.queryId === 'number' && typeof message.id === 'string' && typeof message.preview === 'boolean') {
                    await this.session.navigate(message.queryId, message.id, message.preview);
                }
                return;
            case 'preview':
                if (typeof message.queryId === 'number' && typeof message.id === 'string' && typeof message.requestId === 'number') {
                    const preview: ReferencePreview | undefined = await this.session.preview(message.queryId, message.id);
                    if (preview && this.view?.visible) {
                        void this.view.webview.postMessage({ type: 'preview', queryId: message.queryId, id: message.id, requestId: message.requestId, preview });
                    }
                }
                return;
        }
    }

    /** 释放上一视图的事件订阅以避免重复处理消息。 */
    private disposeViewSubscriptions(): void {
        for (const subscription of this.viewSubscriptions) {
            subscription.dispose();
        }
        this.viewSubscriptions = [];
    }

    /** 生成仅加载扩展本地脚本和样式的视图文档。 */
    private createHtml(webview: vscode.Webview): string {
        const nonce: string = randomBytes(24).toString('base64');
        const css: vscode.Uri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'referenceView.css'));
        const script: vscode.Uri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'referenceView.js'));
        const highlighter: vscode.Uri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'highlight.min.js'));
        const syntax: vscode.Uri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'syntaxHighlight.js'));
        return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"><title>智能引用</title></head>
<body>
<header class="toolbar"><strong id="query-title">智能引用</strong><span id="counts" role="status" aria-live="polite"></span>
<div class="actions"><select id="search-mode" aria-label="搜索模式"><option value="references">精确引用</option><option value="text">快速文本匹配</option></select><button id="refresh" type="button" title="按当前模式重新查询">重新查询</button><button id="cancel" type="button" hidden>取消</button><button id="clear" type="button">清空</button>
<select id="group" aria-label="分组方式"><option value="file">按文件分组</option><option value="workspace">按工作区分组</option><option value="flat">平铺列表</option></select>
<button id="collapse" type="button">折叠</button><button id="wrap" type="button" aria-pressed="false">换行</button><button id="preview-toggle" type="button" aria-pressed="false">预览</button><button id="stripes-toggle" type="button" aria-pressed="true">隔行底色</button><button id="columns-toggle" type="button" aria-haspopup="dialog" aria-controls="column-menu" aria-expanded="false">显示列</button></div>
<input id="filter" type="search" aria-label="筛选引用" placeholder="筛选代码、文件、路径或成员…"></header>
<div id="banner" class="banner" role="status" hidden></div>
<main id="results-layout"><div id="table-scroll" role="grid" aria-label="引用结果" tabindex="0"><div id="table-content"><div id="table-header" role="row"></div><div id="virtual-space"><div id="visible-rows"></div></div></div></div>
<div id="empty" class="empty" role="status"></div>
<aside id="preview-pane" aria-label="引用上下文" hidden><div id="preview-title" class="preview-title">引用上下文</div><pre id="preview-code"></pre></aside></main>
<footer><span id="selected-path">完整代码行 · 拖动表头分隔线调整列宽</span><span id="hint">单击预览 · 双击或 Enter 打开</span></footer>
<div id="column-menu" role="dialog" aria-labelledby="column-menu-title" hidden><div id="column-menu-title" class="column-menu-title">显示列</div><div id="column-options"></div><button id="columns-reset" type="button">恢复默认列</button></div>
<script nonce="${nonce}" src="${highlighter}"></script><script nonce="${nonce}" src="${syntax}"></script><script nonce="${nonce}" src="${script}"></script></body></html>`;
    }
}
