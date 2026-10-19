import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import * as vscode from 'vscode';
import { ReferenceRecord } from '../models/referenceModels';
import { runLimited, textFingerprint } from './referenceService';

const defaultInclude: string = '**/*.{cs,csx,shader,hlsl,cginc,compute,c,cc,cpp,cxx,h,hh,hpp,ts,tsx,js,jsx,lua,py,json,xml,uxml,uss,css,html,sql,md,txt,asmdef,asmref}';
const defaultExclude: string = '**/{Library,Temp,Logs,Build,Builds,obj,bin,node_modules,.git,.vs,.vscode-test,out,dist}/**';

/** 保存快速文本匹配的范围和资源上限。 */
export interface TextSearchOptions {
    include: string;
    exclude: string;
    maxFiles: number;
    maxResults: number;
    maxFileBytes: number;
    matchCase: boolean;
    wholeWord: boolean;
}

/** 表示直接读取的源码快照及其可选编辑器文档。 */
export interface TextSource {
    text: string;
    language: string;
    document?: vscode.TextDocument;
    version: number;
}

/** 描述一次文本扫描的完成情况和受限原因。 */
export interface TextSearchSummary {
    scannedFiles: number;
    totalFiles: number;
    warnings: string[];
}

/** 读取资源范围内的快速搜索设置并限制异常配置值。 */
export function getTextSearchOptions(uri: vscode.Uri): TextSearchOptions {
    const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('smart-reference', uri);
    /** 读取合法的整数设置并约束取值范围。 */
    function integer(key: string, fallback: number, min: number, max: number): number {
        const value: unknown = config.get(`quickSearch.${key}`);
        return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(Math.max(min, Math.min(max, value))) : fallback;
    }
    const include: unknown = config.get('quickSearch.include');
    const exclude: unknown = config.get('quickSearch.exclude');
    return {
        include: typeof include === 'string' && include.trim() ? include : defaultInclude,
        exclude: typeof exclude === 'string' ? exclude : defaultExclude,
        maxFiles: integer('maxFiles', 20000, 1, 100000),
        maxResults: integer('maxResults', 5000, 1, 50000),
        maxFileBytes: integer('maxFileSizeMB', 2, 1, 32) * 1024 * 1024,
        matchCase: config.get<boolean>('quickSearch.matchCase', true),
        wholeWord: config.get<boolean>('quickSearch.wholeWord', false)
    };
}

/** 统一 Windows 本地文件的键以复用不同大小写 URI 对应的未保存文档。 */
function uriKey(uri: vscode.Uri): string {
    return uri.scheme === 'file' && process.platform === 'win32' ? uri.toString().toLowerCase() : uri.toString();
}

/** 合并快速搜索排除项和工作区中明确启用的文件排除项。 */
function excludePattern(folder: vscode.WorkspaceFolder, configured: string): string | undefined {
    const patterns: string[] = configured ? [configured] : [];
    for (const section of ['files', 'search']) {
        const excludes: Record<string, unknown> = vscode.workspace.getConfiguration(section, folder.uri).get<Record<string, unknown>>('exclude', {});
        for (const [pattern, enabled] of Object.entries(excludes)) {
            if (enabled === true) {
                patterns.push(pattern);
            }
        }
    }
    return patterns.length > 1 ? `{${patterns.join(',')}}` : patterns[0];
}

/** 按文件后缀提供本地语法着色所需的语言标识。 */
function inferLanguage(uri: vscode.Uri): string {
    const languages: Record<string, string> = {
        '.cs': 'csharp', '.csx': 'csharp', '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
        '.json': 'json', '.asmdef': 'json', '.asmref': 'json', '.xml': 'xml', '.uxml': 'xml', '.html': 'html', '.css': 'css', '.uss': 'css',
        '.py': 'python', '.lua': 'lua', '.sql': 'sql', '.md': 'markdown', '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp'
    };
    return languages[path.posix.extname(uri.path).toLowerCase()] ?? '';
}

/** 按 BOM 或工作区编码设置解码源码并拒绝无效字节。 */
function decodeText(bytes: Uint8Array, uri: vscode.Uri): string {
    const configured: string = vscode.workspace.getConfiguration('files', uri).get<string>('encoding', 'utf8');
    const encodings: Record<string, string> = { utf8: 'utf-8', utf8bom: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be', shiftjis: 'shift_jis', eucjp: 'euc-jp', euckr: 'euc-kr', koi8r: 'koi8-r', koi8u: 'koi8-u' };
    let encoding: string = encodings[configured] ?? configured.replace(/^windows(\d+)$/, 'windows-$1');
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        encoding = 'utf-16le';
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        encoding = 'utf-16be';
    } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        encoding = 'utf-8';
    }
    const text: string = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (text.includes('\0')) {
        throw new Error('文件包含二进制内容');
    }
    return text;
}

/** 优先读取已打开文档的未保存内容并直接从文件系统读取其他源码。 */
export async function readTextSource(uri: vscode.Uri, maxBytes: number): Promise<TextSource> {
    const document: vscode.TextDocument | undefined = vscode.workspace.textDocuments.find((candidate: vscode.TextDocument): boolean => !candidate.isClosed && uriKey(candidate.uri) === uriKey(uri));
    if (document) {
        const text: string = document.getText();
        if (Buffer.byteLength(text, 'utf8') > maxBytes) {
            throw new Error('文件超过快速搜索大小限制');
        }
        return { text, document, version: document.version, language: document.languageId };
    }
    const size: number = uri.scheme === 'file' ? (await fs.stat(uri.fsPath)).size : (await vscode.workspace.fs.stat(uri)).size;
    if (size > maxBytes) {
        throw new Error('文件超过快速搜索大小限制');
    }
    const bytes: Uint8Array = uri.scheme === 'file' ? await fs.readFile(uri.fsPath) : await vscode.workspace.fs.readFile(uri);
    if (bytes.length > maxBytes) {
        throw new Error('文件超过快速搜索大小限制');
    }
    return { text: decodeText(bytes, uri), version: 0, language: inferLanguage(uri) };
}

/** 将单行字面文本转换成支持大小写和 Unicode 全字边界的匹配器。 */
export function createTextPattern(query: string, options: Pick<TextSearchOptions, 'matchCase' | 'wholeWord'>): RegExp {
    if (!query || query.length > 256 || /[\r\n\0]/.test(query)) {
        throw new Error('快速文本匹配需要 1 至 256 个字符的单行文本。');
    }
    const escaped: string = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const identifier: string = '[\\p{L}\\p{N}\\p{M}\\p{Pc}\\u200c\\u200d]';
    const pattern: string = options.wholeWord ? `(?<!${identifier})${escaped}(?!${identifier})` : escaped;
    return new RegExp(pattern, options.matchCase ? 'gu' : 'giu');
}

/** 将匹配行转换为可导航记录并合并同一行的全部命中范围。 */
function matchSource(uri: vscode.Uri, source: TextSource, pattern: RegExp, maxRows: number, current: () => boolean): { records: ReferenceRecord[]; clipped: boolean } {
    pattern.lastIndex = 0;
    if (!pattern.test(source.text)) {
        return { records: [], clipped: false };
    }
    const hash: string = textFingerprint(source.text, true);
    const lines: string[] = source.text.split(/\r\n|\n|\r/);
    const records: ReferenceRecord[] = [];
    const relativePath: string = vscode.workspace.asRelativePath(uri, true);
    const workspace: string = vscode.workspace.getWorkspaceFolder(uri)?.name ?? '工作区外';
    let clipped: boolean = false;
    for (let index: number = 0; index < lines.length && records.length < maxRows && current(); index++) {
        const text: string = lines[index];
        const ranges: { start: number; end: number }[] = [];
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            if (ranges.length >= 1000) {
                clipped = true;
                break;
            }
            ranges.push({ start: match.index, end: match.index + match[0].length });
        }
        if (ranges.length === 0) {
            continue;
        }
        const first: { start: number; end: number } = ranges[0];
        const location: vscode.Location = new vscode.Location(uri, new vscode.Range(index, first.start, index, first.end));
        // 复制命中行，避免文本切片长期保留整份文件内容。
        const copiedText: string = Buffer.from(text, 'utf16le').toString('utf16le');
        records.push({
            location, document: source.document, version: source.version, documentHash: hash, normalizeLineEndings: true,
            item: {
                id: `text:${uri.toString()}:${index}`, uri: uri.toString(), file: path.posix.basename(uri.path), path: relativePath, workspace,
                line: index + 1, column: first.start + 1, text: copiedText, language: source.language,
                highlightStart: first.start, highlightEnd: first.end, highlightRanges: ranges, member: '', type: ''
            }
        });
    }
    return { records, clipped };
}

/** 在工作区内并发扫描文本并逐文件回传匹配行而不调用语言服务。 */
export async function searchTextMatches(query: string, resource: vscode.Uri, current: () => boolean, token: vscode.CancellationToken, onBatch: (records: ReferenceRecord[]) => void, onProgress: (scanned: number, total: number) => void): Promise<TextSearchSummary> {
    const folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        throw new Error('请先打开工作区文件夹，再使用快速文本匹配。');
    }
    const options: TextSearchOptions = getTextSearchOptions(resource);
    createTextPattern(query, options);
    const lists: vscode.Uri[][] = await Promise.all(folders.map(async (folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> => {
        const scoped: TextSearchOptions = getTextSearchOptions(folder.uri);
        return vscode.workspace.findFiles(new vscode.RelativePattern(folder, scoped.include), excludePattern(folder, scoped.exclude), options.maxFiles + 1, token);
    }));
    const files: vscode.Uri[] = Array.from(new Map(lists.flat().map((uri: vscode.Uri) => [uriKey(uri), uri])).values());
    const warnings: string[] = [];
    if (files.length > options.maxFiles) {
        warnings.push(`文件数已达到 ${options.maxFiles} 个上限，请缩小 quickSearch.include 范围或调整 maxFiles。`);
        files.length = options.maxFiles;
    }
    let scanned: number = 0;
    let matchedRows: number = 0;
    let skipped: number = 0;
    let clipped: boolean = false;
    const errors: string[] = [];
    const scanning: () => boolean = (): boolean => current() && !token.isCancellationRequested && matchedRows < options.maxResults;
    onProgress(0, files.length);
    await runLimited(files, 8, scanning, async (uri: vscode.Uri): Promise<void> => {
        try {
            const source: TextSource = await readTextSource(uri, options.maxFileBytes);
            if (!scanning()) {
                return;
            }
            const found: { records: ReferenceRecord[]; clipped: boolean } = matchSource(uri, source, createTextPattern(query, options), options.maxResults - matchedRows, scanning);
            matchedRows += found.records.length;
            clipped = clipped || found.clipped;
            if (found.records.length > 0) {
                onBatch(found.records);
            }
        } catch (error: unknown) {
            if (current() && !token.isCancellationRequested) {
                skipped++;
                if (errors.length < 5) {
                    errors.push(`${vscode.workspace.asRelativePath(uri, true)}：${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
        if (current() && !token.isCancellationRequested) {
            onProgress(++scanned, files.length);
        }
    });
    if (matchedRows >= options.maxResults) {
        warnings.push(`已达到 ${options.maxResults} 个匹配行上限，可调整 quickSearch.maxResults 或缩小搜索范围。`);
    }
    if (skipped > 0) {
        warnings.push(`已跳过 ${skipped} 个过大、编码无效或无法读取的文件。`, ...errors);
    }
    if (clipped) {
        warnings.push('部分代码行匹配过多，仅标记该行前 1000 处命中。');
    }
    return { scannedFiles: scanned, totalFiles: files.length, warnings };
}
