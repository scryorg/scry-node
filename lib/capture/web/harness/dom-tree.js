/**
 * The `dom` structure tree for a captured story (Scry Capture Format scf-tree/1).
 *
 * The same collector scry-sbcov runs for a built Storybook, so both capture paths describe a
 * story the same way: every rendered element under the captured element with its type, role,
 * testId, own text, bounds in CSS px relative to the image's top-left, and the computed styles
 * the format lists. A missing key means "unknown".
 *
 * `collectDomTree` runs inside the page (Playwright serialises it): self-contained, no imports.
 */
/* global window, document, getComputedStyle */

/**
 * @param {{mark: string, viewport: boolean, fullPage?: boolean, maxNodes: number}} args
 *   mark: attribute on the element the screenshot was cropped to; viewport: the image is the
 *   viewport; fullPage: the image is the whole scrollable page.
 */
function collectDomTree(args) {
    const marked = document.querySelector(`[${args.mark}="1"]`);
    const whole = args.viewport || args.fullPage;
    const root = (whole ? null : marked) || document.querySelector('#storybook-root') || document.body;
    if (!root) return null;
    const rootRect = root.getBoundingClientRect();
    let origin = { x: rootRect.x, y: rootRect.y };
    if (args.fullPage) origin = { x: -window.scrollX, y: -window.scrollY };
    else if (args.viewport || !marked) origin = { x: 0, y: 0 };
    let count = 0;
    const round = (n) => Math.round(n * 100) / 100;
    const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
    const color = (v) => {
        // eslint-disable-next-line sonarjs/regex-complexity -- the same pattern scry-sbcov uses, kept identical
        const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(String(v).trim());
        if (!m) return undefined;
        let a = 1;
        if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        const alpha = a >= 1 ? '' : hex2(a * 255);
        return `#${hex2(+m[1])}${hex2(+m[2])}${hex2(+m[3])}${alpha}`;
    };
    const px = (v) => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? round(n) : undefined;
    };
    const IMPLICIT_ROLE = {
        button: 'button', a: 'link', img: 'img', input: 'textbox', textarea: 'textbox', select: 'combobox',
        h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
        ul: 'list', ol: 'list', li: 'listitem', nav: 'navigation', dialog: 'dialog', table: 'table',
    };
    const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META']);

    // eslint-disable-next-line sonarjs/cognitive-complexity -- the same collector scry-sbcov runs, kept identical
    const visit = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none') return null;
        count++;
        const tag = el.tagName.toLowerCase();
        const node = { type: tag };
        const role = el.getAttribute('role') || IMPLICIT_ROLE[tag];
        if (role) node.role = role;
        const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
        if (testId) node.testId = testId;
        let text = '';
        el.childNodes.forEach((c) => {
            if (c.nodeType === 3) text += c.textContent || '';
        });
        text = text.replace(/\s+/g, ' ').trim();
        if (text) node.text = text.slice(0, 500);
        const r = el.getBoundingClientRect();
        node.bounds = { x: round(r.x - origin.x), y: round(r.y - origin.y), width: round(r.width), height: round(r.height) };

        const style = {};
        const set = (k, v) => {
            if (v !== undefined && v !== '') style[k] = v;
        };
        set('color', color(cs.color));
        const bg = color(cs.backgroundColor);
        if (bg && bg !== '#00000000') set('background', bg);
        set('fontFamily', (cs.fontFamily.split(',')[0] || '').trim().replace(/^["']|["']$/g, '') || undefined);
        set('fontSize', px(cs.fontSize));
        set('fontWeight', Number(cs.fontWeight) || undefined);
        if (cs.lineHeight !== 'normal') set('lineHeight', px(cs.lineHeight));
        set('letterSpacing', cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing));
        const radius = px(cs.borderTopLeftRadius);
        if (radius) set('cornerRadius', radius);
        if (cs.borderTopStyle !== 'none' && px(cs.borderTopWidth)) {
            set('borderWidth', px(cs.borderTopWidth));
            set('borderColor', color(cs.borderTopColor));
        }
        const padding = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map((v) => px(v) ?? 0);
        if (padding.some((v) => v !== 0)) style.padding = padding;
        const opacity = parseFloat(cs.opacity);
        if (Number.isFinite(opacity) && opacity !== 1) set('opacity', opacity);
        if (cs.boxShadow && cs.boxShadow !== 'none') set('shadow', cs.boxShadow);
        if (Object.keys(style).length) node.style = style;

        if (tag !== 'svg') {
            const children = [];
            for (const child of Array.from(el.children)) {
                if (count >= args.maxNodes) break;
                if (SKIP.has(child.tagName)) continue;
                const c = visit(child);
                if (c) children.push(c);
            }
            if (children.length) node.children = children;
        }
        return node;
    };
    return visit(root);
}

module.exports = { collectDomTree };
