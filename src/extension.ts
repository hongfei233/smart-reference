import * as vscode from 'vscode';
import { ReferenceSession } from './references/referenceSession';
import { documentFingerprint } from './references/referenceService';
import { ReferenceViewProvider } from './views/referenceViewProvider';
import { ReferenceSearchMode } from './models/referenceModels';

/** 激活扩展并注册命令。 */
export function activate(context: vscode.ExtensionContext): void {
    const session: ReferenceSession = new ReferenceSession(context.workspaceState);
    const provider: ReferenceViewProvider = new ReferenceViewProvider(context.extensionUri, session);

    /** 从编辑器捕获符号或单行选中文本并启动对应模式的查询。 */
    async function startSearch(mode: ReferenceSearchMode): Promise<void> {
        const editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
        if (!editor) {
            void vscode.window.showInformationMessage('请先在编辑器中选中文本或将光标放到需要查找的单词上。');
            return;
        }
        const position: vscode.Position = mode === 'text' && !editor.selection.isEmpty ? editor.selection.start : editor.selection.active;
        const range: vscode.Range | undefined = editor.document.getWordRangeAtPosition(position);
        const selected: string = mode === 'text' && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim() : '';
        const label: string = selected || (range ? editor.document.getText(range) : '');
        if (mode === 'text' && (!label || label.length > 256 || /[\r\n\0]/.test(label))) {
            void vscode.window.showInformationMessage('请选择 1 至 256 个字符的单行文本，或将光标放到要匹配的单词上。');
            return;
        }
        const search: Promise<void> = session.search({
            uri: editor.document.uri, position, version: editor.document.version,
            label: label || `第 ${position.line + 1} 行的符号`, document: editor.document,
            documentHash: documentFingerprint(editor.document)
        }, mode);
        await provider.show();
        await search;
    }

    context.subscriptions.push(
        session,
        provider,
        vscode.window.registerWebviewViewProvider(ReferenceViewProvider.viewId, provider),
        vscode.commands.registerCommand('smart-reference.findReferences', (): Promise<void> => startSearch('references')),
        vscode.commands.registerCommand('smart-reference.findTextMatches', (): Promise<void> => startSearch('text')),
        vscode.commands.registerCommand('smart-reference.show', (): Promise<void> => provider.show()),
        vscode.commands.registerCommand('smart-reference.refresh', (): Promise<void> => session.refresh()),
        vscode.commands.registerCommand('smart-reference.clear', (): void => session.clear())
    );
}
