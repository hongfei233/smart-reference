(() => {
    'use strict';
    const cache = new Map();
    let cachedCharacters = 0;
    const aliases = { csharp: 'csharp', 'c#': 'csharp', cs: 'csharp', typescriptreact: 'typescript', javascriptreact: 'javascript', shellscript: 'bash' };
    const extensions = { cs: 'csharp', csx: 'csharp', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', py: 'python', cpp: 'cpp', cc: 'cpp', h: 'cpp', c: 'c', css: 'css', html: 'xml', xml: 'xml', xaml: 'xml', lua: 'lua', sql: 'sql', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'bash', ps1: 'powershell' };
    const systemTypes = new Set(['Boolean', 'Byte', 'SByte', 'Char', 'Decimal', 'Double', 'Single', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64', 'IntPtr', 'UIntPtr', 'String', 'Object', 'Void', 'DateTime', 'DateTimeOffset', 'TimeSpan', 'Guid']);

    /** 将引用命中范围作为文本安全渲染并保留外层语法颜色。 */
    function appendMarked(container, text, ranges, offset = 0) {
        let cursor = 0;
        for (const range of ranges) {
            const start = Math.max(cursor, range.start - offset);
            const end = Math.min(text.length, range.end - offset);
            if (end <= start) {
                continue;
            }
            container.append(document.createTextNode(text.slice(cursor, start)));
            const mark = document.createElement('mark');
            mark.textContent = text.slice(start, end);
            container.append(mark);
            cursor = end;
        }
        container.append(document.createTextNode(text.slice(cursor)));
    }

    /** 根据文档语言或文件后缀选择本地语法而不触发自动检测。 */
    function resolveLanguage(language, file) {
        const highlighter = window.hljs;
        const id = typeof language === 'string' ? language.toLowerCase() : '';
        if (!highlighter || id === 'plaintext') {
            return '';
        }
        const extension = file.split('.').pop().toLowerCase();
        const requested = Object.hasOwn(aliases, id) ? aliases[id] : id || (Object.hasOwn(extensions, extension) ? extensions[extension] : '');
        return requested && highlighter.getLanguage(requested) ? requested : '';
    }

    /** 为普通代码中的常见 System 类型补充颜色并避开字符串和注释。 */
    function addSystemTypeColors(runs) {
        const colored = [];
        for (const run of runs) {
            if (/hljs-(?:string|comment|quote|regexp|title|keyword|literal|number|meta)\b/.test(run.classes)) {
                colored.push(run);
                continue;
            }
            let offset = 0;
            for (const match of run.text.matchAll(/\b[A-Za-z_][A-Za-z_0-9]*\b/g)) {
                if (systemTypes.has(match[0])) {
                    if (match.index > offset) {
                        colored.push({ text: run.text.slice(offset, match.index), classes: run.classes });
                    }
                    colored.push({ text: match[0], classes: `${run.classes} hljs-type`.trim() });
                    offset = match.index + match[0].length;
                }
            }
            if (offset < run.text.length) {
                colored.push({ text: run.text.slice(offset), classes: run.classes });
            }
        }
        return colored;
    }

    /** 将高亮器输出转换成只包含文本和颜色类的安全片段。 */
    function tokenize(text, language) {
        const key = `${language}\0${text}`;
        const cached = cache.get(key);
        if (cached) {
            cache.delete(key);
            cache.set(key, cached);
            return cached;
        }
        let runs;
        try {
            const template = document.createElement('template');
            template.innerHTML = window.hljs.highlight(text, { language, ignoreIllegals: true }).value;
            runs = [];
            /** 仅提取高亮器生成的文本和语法类并丢弃其他标记。 */
            function visit(node, classes) {
                if (node.nodeType === 3) {
                    if (node.textContent) {
                        runs.push({ text: node.textContent, classes });
                    }
                    return;
                }
                const ownClasses = node.nodeName === 'SPAN' ? Array.from(node.classList).filter((name) => /^(hljs-[\w-]+|[\w-]+_)$/.test(name)).join(' ') : '';
                const nextClasses = [classes, ownClasses].filter(Boolean).join(' ');
                for (const child of node.childNodes) {
                    visit(child, nextClasses);
                }
            }
            visit(template.content, '');
            if (runs.map((run) => run.text).join('') !== text) {
                runs = [{ text, classes: '' }];
            }
            if (language === 'csharp' || language === 'cs' || language === 'c#') {
                runs = addSystemTypeColors(runs);
            }
        } catch {
            runs = [{ text, classes: '' }];
        }
        cache.set(key, runs);
        cachedCharacters += key.length;
        while (cache.size > 512 || cachedCharacters > 500000) {
            const oldest = cache.keys().next().value;
            cachedCharacters -= oldest.length;
            cache.delete(oldest);
        }
        return runs;
    }

    /** 为可见代码添加本地语法颜色并精确叠加引用命中范围。 */
    function append(container, text, start, end, language, file = '', matches) {
        const ranges = (matches || [{ start, end }]).filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end > range.start)
            .sort((left, right) => left.start - right.start);
        const resolved = resolveLanguage(language, file);
        if (!resolved || text.length > 10000) {
            appendMarked(container, text, ranges);
            return;
        }
        let offset = 0;
        for (const run of tokenize(text, resolved)) {
            const node = run.classes ? document.createElement('span') : container;
            if (node !== container) {
                node.className = run.classes;
                container.append(node);
            }
            appendMarked(node, run.text, ranges, offset);
            offset += run.text.length;
        }
    }

    window.smartReferenceSyntax = Object.freeze({ append });
})();
