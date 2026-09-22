(function (root) {
    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    function safeHttpUrl(value) {
        try {
            const url = new URL(String(value || ''));
            return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
        } catch {
            return null;
        }
    }

    function linkedText(text, url) {
        const escaped = escapeHtml(text);
        const href = safeHttpUrl(url);
        return href
            ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escaped}</a>`
            : escaped;
    }

    function format(record) {
        if (!record || typeof record !== 'object') return null;
        const name = String(record.name || '').trim();
        if (!name) return null;
        const source = linkedText(name, record.url);
        const license = String(record.license || '').trim();
        return license ? `${source} · ${linkedText(license, record.licenseUrl)}` : source;
    }

    function formatAll(records) {
        if (!Array.isArray(records)) return [];
        return [...new Set(records.map(format).filter(Boolean))];
    }

    function section(records, heading) {
        const entries = formatAll(records);
        if (!entries.length) return '';
        return `<section data-provider-attributions><h4>${escapeHtml(heading)}</h4><ul>`
            + entries.map(entry => `<li>${entry}</li>`).join('')
            + '</ul></section>';
    }

    const api = Object.freeze({ format, formatAll, section });
    root.__transitProviderAttribution = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
