const fs = require('node:fs');
const path = require('node:path');

/** 复制固定版本的本地高亮资源和许可证供视图离线加载。 */
function prepareMedia() {
    const sourceRoot = path.dirname(require.resolve('@highlightjs/cdn-assets/package.json'));
    const targetRoot = path.resolve(__dirname, '..', 'media', 'vendor');
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, 'highlight.min.js'), path.join(targetRoot, 'highlight.min.js'));
    fs.copyFileSync(path.join(sourceRoot, 'LICENSE'), path.join(targetRoot, 'highlight-LICENSE.txt'));
}

prepareMedia();
