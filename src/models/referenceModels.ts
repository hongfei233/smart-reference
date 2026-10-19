import * as vscode from 'vscode';

/** 定义精确引用和快速文本匹配两种搜索模式。 */
export type ReferenceSearchMode = 'references' | 'text';

/** 保存引用查询的原始符号位置。 */
export interface ReferenceTarget {
    uri: vscode.Uri;
    position: vscode.Position;
    version: number;
    label: string;
    document: vscode.TextDocument;
    documentHash: string;
}

/** 表示可以安全发送给引用窗口的结果条目。 */
export interface ReferenceItem {
    id: string;
    uri: string;
    file: string;
    path: string;
    workspace: string;
    line: number;
    column: number;
    text: string;
    language: string;
    highlightStart: number;
    highlightEnd: number;
    highlightRanges?: { start: number; end: number }[];
    member: string;
    type: string;
}

/** 保存引用跳转所需的文档版本和真实范围。 */
export interface ReferenceRecord {
    item: ReferenceItem;
    location: vscode.Location;
    version: number;
    document?: vscode.TextDocument;
    documentHash: string;
    normalizeLineEndings?: boolean;
}

/** 描述一次引用查询的可见状态。 */
export interface ReferenceSnapshot {
    queryId: number;
    mode: ReferenceSearchMode;
    status: 'idle' | 'loading' | 'ready' | 'error';
    label: string;
    source: string;
    items: ReferenceItem[];
    stale: boolean;
    message: string;
    warnings: string[];
    enriching: boolean;
}

/** 表示引用附近可供预览的原始代码行。 */
export interface ReferencePreview {
    path: string;
    line: number;
    language?: string;
    lines: { number: number; text: string; start: number; end: number; ranges?: { start: number; end: number }[] }[];
    error?: string;
}
