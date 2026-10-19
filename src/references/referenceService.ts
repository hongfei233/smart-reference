import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { ReferenceItem, ReferenceRecord } from '../models/referenceModels';

/** 使用有限并发处理任务并在查询失效后停止分配新任务。 */
export async function runLimited<T>(items: readonly T[], concurrency: number, current: () => boolean, action: (item: T) => Promise<void>): Promise<void> {
    let index: number = 0;
    const workers: Promise<void>[] = Array.from({ length: Math.min(concurrency, items.length) }, async (): Promise<void> => {
        while (current() && index < items.length) {
            const item: T = items[index++];
            await action(item);
        }
    });
    await Promise.all(workers);
}

/** 对语言服务返回的引用去重并按文件和位置排序。 */
export function normalizeLocations(locations: readonly vscode.Location[]): vscode.Location[] {
    const unique: Map<string, vscode.Location> = new Map();
    for (const location of locations) {
        const range: vscode.Range = location.range;
        const key: string = `${location.uri.toString()}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
        unique.set(key, location);
    }
    return Array.from(unique.values()).sort((left: vscode.Location, right: vscode.Location): number =>
        left.uri.toString().localeCompare(right.uri.toString()) || left.range.start.compareTo(right.range.start) || left.range.end.compareTo(right.range.end));
}

/** 将引用位置转换成包含完整物理代码行的显示条目。 */
export function createRecord(document: vscode.TextDocument, location: vscode.Location, id: string, documentHash: string): ReferenceRecord {
    const line: vscode.TextLine = document.lineAt(location.range.start.line);
    const uri: vscode.Uri = location.uri;
    const item: ReferenceItem = {
        id,
        uri: uri.toString(),
        file: path.posix.basename(uri.path),
        path: vscode.workspace.asRelativePath(uri, true),
        workspace: vscode.workspace.getWorkspaceFolder(uri)?.name ?? '工作区外',
        line: location.range.start.line + 1,
        column: location.range.start.character + 1,
        text: line.text,
        language: document.languageId,
        highlightStart: Math.min(location.range.start.character, line.text.length),
        highlightEnd: Math.min(location.range.end.line === location.range.start.line ? location.range.end.character : line.text.length, line.text.length),
        member: '',
        type: ''
    };
    return { item, location, version: document.version, document, documentHash };
}

/** 计算文档内容指纹以识别关闭重开后的实际内容变化。 */
export function documentFingerprint(document: vscode.TextDocument): string {
    return textFingerprint(document.getText());
}

/** 计算文本内容指纹并按需要统一不会影响行列位置的换行符。 */
export function textFingerprint(text: string, normalizeLineEndings: boolean = false): string {
    return createHash('sha256').update(normalizeLineEndings ? text.replace(/\r\n?/g, '\n') : text).digest('hex');
}

/** 根据文档实例和内容指纹验证保存的位置是否仍然有效。 */
export function documentMatches(document: vscode.TextDocument, original: { document?: vscode.TextDocument; version: number; documentHash: string; normalizeLineEndings?: boolean }): boolean {
    return (document === original.document && document.version === original.version) || textFingerprint(document.getText(), original.normalizeLineEndings) === original.documentHash;
}

/** 判断符号种类是否表示包含引用的类型。 */
function isType(kind: vscode.SymbolKind): boolean {
    return kind === vscode.SymbolKind.Class || kind === vscode.SymbolKind.Struct || kind === vscode.SymbolKind.Interface || kind === vscode.SymbolKind.Enum;
}

/** 从文档符号范围补充引用所属的类型和成员。 */
export function enrichRecord(record: ReferenceRecord, symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): void {
    const position: vscode.Position = record.location.range.start;
    let bestDepth: number = -1;
    let bestSize: number = Number.POSITIVE_INFINITY;
    /** 递归查找包含引用的最内层符号。 */
    function visit(nodes: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[], parentType: string, parentMember: string, depth: number): void {
        for (const symbol of nodes) {
            const hierarchical: boolean = 'children' in symbol;
            const range: vscode.Range = 'range' in symbol ? symbol.range : symbol.location.range;
            if (!range.contains(position)) {
                continue;
            }
            const type: string = isType(symbol.kind) ? symbol.name : parentType;
            const member: string = isType(symbol.kind) || symbol.kind === vscode.SymbolKind.Namespace || symbol.kind === vscode.SymbolKind.Module
                ? parentMember : symbol.name;
            const size: number = (range.end.line - range.start.line) * 1000000 + range.end.character - range.start.character;
            if (depth > bestDepth || (depth === bestDepth && size < bestSize)) {
                bestDepth = depth;
                bestSize = size;
                record.item.type = type;
                record.item.member = member;
                if (!hierarchical && !record.item.type && 'containerName' in symbol) {
                    record.item.member = [symbol.containerName, member].filter(Boolean).join('.');
                }
            }
            if ('children' in symbol) {
                visit(symbol.children, type, member, depth + 1);
            }
        }
    }
    visit(symbols, '', '', 0);
}
