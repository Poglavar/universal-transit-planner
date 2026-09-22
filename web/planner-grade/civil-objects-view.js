// The "Objekti na mreži" table: a per-kind summary plus one row per detected
// structure, with an editable price on every row. Shared by the planner
// (transit.js) and the leaderboard (leaderboard.js) so the same bill renders the
// same way on both, from the same numbers.
//
// Hand-typed prices are a local overlay: transit-pricing.js stores them in this
// browser and nothing sends them to the server. That is stated in the table
// itself, because a number you typed that quietly fails to travel is worse than
// no number at all.
//
// UMD: classic scripts get window.__civilObjectsView, node tests require() it.
// render() is pure string-building; only attach() touches the DOM.
(function (root) {
    'use strict';

    const STATION_KIND_LABELS = {
        tunnel: 'podzemna',
        covered: 'natkrivena',
        cut: 'u usjeku',
        elevated: 'nadzemna',
        surface: 'površinska',
    };
    const TRANSFER_TYPE_LABELS = { underground: 'podzemno', overground: 'nadzemno' };
    const MILLION = 1_000_000;

    // The name cell carries markup (the grey qualifier span); sorting has to
    // compare what is read, not the tags around it.
    function plainText(html) {
        return String(html == null ? '' : html)
            .replace(/<[^>]*>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // "42 objekta" / "5 objekata" / "1 objekt" — Croatian counts the noun, and a
    // hardcoded plural reads as broken on every list that is not exactly 5 long.
    // forms: [1, 2-4, 5+], e.g. ['objekt', 'objekta', 'objekata'].
    function countText(count, forms) {
        const n = Math.abs(Math.round(count));
        const lastTwo = n % 100;
        const last = n % 10;
        if (lastTwo >= 11 && lastTwo <= 14) return `${n} ${forms[2]}`;
        if (last === 1) return `${n} ${forms[0]}`;
        if (last >= 2 && last <= 4) return `${n} ${forms[1]}`;
        return `${n} ${forms[2]}`;
    }

    function objectCountText(count) {
        return countText(count, ['objekt', 'objekta', 'objekata']);
    }

    function defaultFormatCost(eur) {
        if (eur >= 1_000_000_000) return `${(eur / 1_000_000_000).toFixed(2)} mlrd EUR`;
        if (eur >= MILLION) return `${(eur / MILLION).toFixed(1)} mil. EUR`;
        return `${Math.round(eur).toLocaleString('en')} EUR`;
    }

    function defaultFormatDistance(meters) {
        if (meters >= 1000) {
            const km = meters / 1000;
            return `${km.toFixed(km >= 10 ? 0 : 1)} km`;
        }
        return `${Math.round(meters).toLocaleString('en')} m`;
    }

    // Rail chainage, the way a railway writes it: 12+450, not "12.45 km". The
    // summed ground-level row has no single position — it is all of them — so it
    // gets a dash rather than a fake kilometre.
    function formatChainage(meters) {
        if (!Number.isFinite(meters)) return '\u2014';
        const whole = Math.max(0, Math.round(meters));
        return `${Math.floor(whole / 1000)}+${String(whole % 1000).padStart(3, '0')}`;
    }

    const SORT_KEYS = ['name', 'chainage', 'length', 'height', 'cost'];

    // What each column sorts on. Anything missing sorts as null and is pinned to
    // the bottom in BOTH directions, so flipping the arrow never buries the rows
    // that do have a value under the ones that do not.
    function sortValue(entryRow, key) {
        if (key === 'name') return entryRow.sortName;
        if (key === 'chainage') return Number.isFinite(entryRow.object.dM0) ? entryRow.object.dM0 : null;
        if (key === 'length') return Number.isFinite(entryRow.object.lengthM) ? entryRow.object.lengthM : null;
        if (key === 'height') return Number.isFinite(entryRow.object.heightM) ? entryRow.object.heightM : null;
        if (key === 'cost') return Number.isFinite(entryRow.costEur) ? entryRow.costEur : null;
        return null;
    }

    // Stable: equal rows keep the order the detector produced (chainage order),
    // which is what makes a sort by a coarse column still read sensibly.
    function sortRows(rows, sort) {
        const key = sort && SORT_KEYS.includes(sort.key) ? sort.key : null;
        if (!key) return rows.slice();
        const sign = sort.direction === 'desc' ? -1 : 1;
        return rows
            .map((entryRow, index) => ({ entryRow, index }))
            .sort((left, right) => {
                const a = sortValue(left.entryRow, key);
                const b = sortValue(right.entryRow, key);
                if (a == null && b == null) return left.index - right.index;
                if (a == null) return 1;
                if (b == null) return -1;
                const compared = typeof a === 'string' ? a.localeCompare(b, 'hr') : a - b;
                return compared !== 0 ? compared * sign : left.index - right.index;
            })
            .map(item => item.entryRow);
    }

    function heightText(object, api) {
        const labels = api.OBJECT_HEIGHT_LABELS;
        if (!Number.isFinite(object.heightM) || !labels[object.kind]) return '—';
        return `${labels[object.kind]} ${object.heightM.toFixed(1)} m`;
    }

    function nameText(object, api) {
        const labels = api.OBJECT_LABELS;
        if (object.kind === 'station') {
            const form = STATION_KIND_LABELS[object.stationKind] || '';
            const label = object.stationType === 'depot' ? 'Remiza' : labels.station;
            const name = object.name ? escapeHtml(object.name) : label;
            return `${name}${form ? ` <span class="civil-objects-note">${form}</span>` : ''}`;
        }
        if (object.kind === 'transfer') {
            const form = TRANSFER_TYPE_LABELS[object.linkType] || '';
            return `${labels.transfer}${form ? ` <span class="civil-objects-note">${form}</span>` : ''}`;
        }
        if (object.kind === 'at-grade' && object.count > 1) {
            return `${labels['at-grade']} <span class="civil-objects-note">(${object.count} dionica)</span>`;
        }
        return labels[object.kind];
    }

    // Icon-only mode: the column is exactly one icon wide. Nothing else is drawn
    // in it — not the type word, not a station's name — because the panel is a
    // third of the screen and every character here is width the numbers need.
    // Whatever the cell would have said moves into its title/aria-label instead,
    // so hovering a station still names it and a screen reader still reads it.
    function compactNameText() {
        return '';
    }

    // What the icon stands for, spelled out for hover and assistive tech.
    function compactCellLabel(object, api) {
        return plainText(nameText(object, api));
    }

    // The cost cell. Editable rows carry the object key and the model price, so
    // resetting never has to re-derive anything and the ✕ can only appear where
    // a hand-typed price actually exists.
    function costCell(object, costEur, manual, editable) {
        const text = escapeHtml(costCell.formatCost(costEur));
        if (!editable || !object.key) return `<td class="civil-objects-num">${text}</td>`;
        const reset = manual
            ? `<button type="button" class="civil-objects-cost-reset" data-key="${escapeHtml(object.key)}"
                   title="Vrati na cijenu iz modela" aria-label="Vrati na cijenu iz modela">&times;</button>`
            : '';
        return `<td class="civil-objects-num">
            <button type="button" class="civil-objects-cost${manual ? ' is-manual' : ''}"
                data-key="${escapeHtml(object.key)}" data-cost="${Math.round(costEur)}"
                title="${manual ? 'Ručno upisana cijena — klik za izmjenu' : 'Klik za ručni upis cijene'}">${text}</button>${reset}
        </td>`;
    }
    costCell.formatCost = defaultFormatCost;

    function row(icon, name, lengthText, height, costHtml, className) {
        return `<tr class="${className || ''}">
            <td class="civil-objects-name">${icon} ${name}</td>
            <td class="civil-objects-num">${lengthText}</td>
            <td class="civil-objects-num">${height}</td>
            ${costHtml}
        </tr>`;
    }

    // An object row carries where it is, so it also carries enough identity for
    // the caller to put the map on it: which section, and which object within it.
    function objectRow(icon, name, chainage, lengthText, height, costHtml, attrs) {
        const locate = attrs && attrs.locatable
            ? ` data-locate="1" tabindex="0" role="button" title="Prikaži na karti"`
            : '';
        const dataset = attrs
            ? ` data-entry="${attrs.entryIndex}" data-object="${attrs.objectIndex}"`
            : '';
        // With the type word dropped, the icon carries it — so the icon itself
        // must be readable, not decorative.
        const nameTitle = attrs && attrs.typeLabel
            ? ` title="${escapeHtml(attrs.typeLabel)}" aria-label="${escapeHtml(attrs.typeLabel)}"`
            : '';
        return `<tr class="civil-objects-row${attrs && attrs.locatable ? ' is-locatable' : ''}"${dataset}${locate}>
            <td class="civil-objects-name"${nameTitle}>${icon}${name ? ` ${name}` : ''}</td>
            <td class="civil-objects-num civil-objects-chainage">${chainage}</td>
            <td class="civil-objects-num">${lengthText}</td>
            <td class="civil-objects-num">${height}</td>
            ${costHtml}
        </tr>`;
    }

    // Sortable column headers. aria-sort is what a screen reader reads and what
    // the arrow is drawn from, so there is one source for both.
    const OBJECT_COLUMNS = [
        { key: 'name', label: 'Objekt', className: 'civil-objects-name' },
        { key: 'chainage', label: 'Stacionaža', className: 'civil-objects-num' },
        { key: 'length', label: 'Duljina', className: 'civil-objects-num' },
        { key: 'height', label: 'Visina', className: 'civil-objects-num' },
        { key: 'cost', label: 'Cijena', className: 'civil-objects-num' },
    ];

    function objectTableHead(sort, compactNames) {
        const cells = OBJECT_COLUMNS.map((column) => {
            // The icon column has no heading in compact mode: there is no word
            // in it to head, and a sortable-looking header over icons invites a
            // sort by a label the reader cannot see.
            if (column.key === 'name' && compactNames) {
                return '<th class="civil-objects-name"><span class="civil-objects-sr-only">Vrsta</span></th>';
            }
            const active = sort && sort.key === column.key;
            const direction = active ? (sort.direction === 'desc' ? 'desc' : 'asc') : null;
            const ariaSort = active ? (direction === 'desc' ? 'descending' : 'ascending') : 'none';
            const arrow = active ? (direction === 'desc' ? ' \u25BC' : ' \u25B2') : '';
            return `<th class="${column.className}" aria-sort="${ariaSort}">
                <button type="button" class="civil-objects-sort${active ? ' is-active' : ''}"
                    data-sort="${column.key}">${escapeHtml(column.label)}<span
                    class="civil-objects-sort-arrow" aria-hidden="true">${arrow}</span></button>
            </th>`;
        }).join('');
        return `<thead><tr>${cells}</tr></thead>`;
    }

    function plainCost(text) {
        return `<td class="civil-objects-num">${text}</td>`;
    }

    // entries: [{ label, gaugeLabel, lengthM, objects, rates, overrides, coarse }]
    // options: { editable, formatCost, formatDistanceMeters, title }
    function render(entries, options) {
        const api = root.__civilObjects;
        if (!api) return '<p class="civil-objects-empty">Modul objekata nije učitan.</p>';
        const opts = options || {};
        const formatCost = opts.formatCost || defaultFormatCost;
        const formatDistance = opts.formatDistanceMeters || defaultFormatDistance;
        const editable = opts.editable !== false;
        costCell.formatCost = formatCost;
        const list = entries || [];
        if (list.length === 0) {
            return '<p class="civil-objects-empty">Mreža još nema nijednu trasu.</p>';
        }

        const summary = api.summarize(list);
        const summaryRows = summary.rows.map((bucket) => row(
            api.OBJECT_ICONS[bucket.kind],
            // Ground-level track is one object per track, so counting it like
            // the structures ("×7") would contradict the row right below it.
            bucket.kind === 'at-grade'
                ? `${api.OBJECT_LABELS['at-grade']} <span class="civil-objects-note">(${bucket.stretches} dionica)</span>`
                : `${api.OBJECT_LABELS[bucket.kind]} <span class="civil-objects-note">×${bucket.count}</span>`,
            bucket.lengthM > 0 ? formatDistance(bucket.lengthM) : '—',
            '',
            plainCost(formatCost(bucket.costEur)),
        )).join('');

        const sort = opts.sort || null;
        const locatable = opts.locatable === true;
        const compactNames = opts.compactNames === true;
        const sections = list.map((entry, entryIndex) => {
            const built = (entry.objects || []).map((object, objectIndex) => ({
                object,
                objectIndex,
                costEur: api.objectCostEur(object, entry.rates, entry.overrides),
                manual: api.hasManualCost(object, entry.overrides),
                // Sorting by name has to use the visible text, not the raw kind —
                // a station sorts under its own name, which is what the reader
                // sees in the column.
                sortName: plainText(nameText(object, api)),
                typeLabel: compactCellLabel(object, api),
            }));
            const rows = sortRows(built, sort).map(item => objectRow(
                api.OBJECT_ICONS[item.object.kind],
                compactNames ? compactNameText() : nameText(item.object, api),
                formatChainage(item.object.dM0),
                item.object.lengthM > 0 ? formatDistance(item.object.lengthM) : '\u2014',
                heightText(item.object, api),
                costCell(item.object, item.costEur, item.manual, editable),
                {
                    entryIndex,
                    objectIndex: item.objectIndex,
                    locatable: locatable && Number.isFinite(item.object.dM0),
                    typeLabel: compactNames ? item.typeLabel : '',
                },
            )).join('');
            const entryCostEur = built.reduce((sum, item) => sum + item.costEur, 0);
            const meta = [entry.gaugeLabel, entry.lengthM > 0 ? formatDistance(entry.lengthM) : '']
                .filter(Boolean).join(' · ');
            const coarse = entry.coarse
                ? ' <span class="civil-objects-note">(bez uzdužnog profila — samo tunel/teren/vijadukt)</span>'
                : '';
            return `<section class="civil-objects-track">
                <h4>${escapeHtml(entry.label)} <span class="civil-objects-note">${escapeHtml(meta)}</span>${coarse}</h4>
                <table class="civil-objects-table civil-objects-table-objects">
                    ${objectTableHead(sort, compactNames)}
                    <tbody>${rows || '<tr><td colspan="5" class="civil-objects-empty">Nema objekata.</td></tr>'}</tbody>
                    <tfoot>${objectRow('', '<strong>Ukupno</strong>', '', '', '', plainCost(formatCost(entryCostEur)), null)
                        .replace('civil-objects-row', 'civil-objects-total')}</tfoot>
                </table>
            </section>`;
        }).join('');

        const manualNote = editable
            ? `<p class="civil-objects-note civil-objects-disclaimer">
                   Cijenu svakog objekta možete kliknuti i upisati ručno — ne košta svaki
                   vijadukt jednako. Ručno upisane cijene spremaju se <strong>samo u ovaj
                   preglednik</strong> (localStorage) i ne šalju se na server.
               </p>`
            : '';

        return `
            <section class="civil-objects-summary">
                <h4>Sažetak po vrsti</h4>
                <table class="civil-objects-table">
                    <thead>
                        <tr><th>Objekt</th><th class="civil-objects-num">Duljina</th>
                            <th class="civil-objects-num"></th><th class="civil-objects-num">Cijena</th></tr>
                    </thead>
                    <tbody>${summaryRows || '<tr><td colspan="4" class="civil-objects-empty">Nema objekata.</td></tr>'}</tbody>
                    <tfoot>${row('', `<strong>Ukupno</strong> <span class="civil-objects-note">${objectCountText(summary.objectCount)}</span>`, formatDistance(summary.totalLengthM), '', plainCost(formatCost(summary.totalCostEur)), 'civil-objects-total')}</tfoot>
                </table>
                <p class="civil-objects-note civil-objects-disclaimer">
                    Cijene su izvedene iz cjenika: osnovna cijena trase na terenu × množitelj
                    vrste objekta. Stanice se broje uz građevinu ispod njih, pa zbroj duljina
                    objekata prelazi duljinu mreže.
                </p>
                ${manualNote}
            </section>
            ${sections}`;
    }

    // Turns the rendered cost buttons into an inline editor. `onCommit(key, eur)`
    // is called with a number (a hand-typed price) or null (reset to the model);
    // the caller stores it and re-renders.
    // onSort(key) — a column header was clicked; the caller flips the direction
    // and re-renders. onLocate(entryIndex, objectIndex) — a row was clicked; the
    // planner puts the map on that structure. The leaderboard passes neither and
    // gets the same table without either behaviour.
    function attach(container, { onCommit, onSort, onLocate } = {}) {
        if (!container) return;
        container.onclick = (event) => {
            const sortButton = event.target.closest('.civil-objects-sort');
            if (sortButton) {
                if (typeof onSort === 'function') onSort(sortButton.dataset.sort);
                return;
            }
            const reset = event.target.closest('.civil-objects-cost-reset');
            if (reset) {
                if (typeof onCommit === 'function') onCommit(reset.dataset.key, null);
                return;
            }
            const button = event.target.closest('.civil-objects-cost');
            if (button) {
                // Editing a price must not also fly the map somewhere.
                if (button.dataset.editing !== '1' && typeof onCommit === 'function') {
                    startEditing(button, onCommit);
                }
                return;
            }
            const locatable = event.target.closest('tr[data-locate]');
            if (locatable && typeof onLocate === 'function') {
                onLocate(Number(locatable.dataset.entry), Number(locatable.dataset.object));
            }
        };
        container.onkeydown = (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const locatable = event.target.closest?.('tr[data-locate]');
            if (!locatable || typeof onLocate !== 'function') return;
            event.preventDefault();
            onLocate(Number(locatable.dataset.entry), Number(locatable.dataset.object));
        };
    }

    function startEditing(button, onCommit) {
        button.dataset.editing = '1';
        const currentEur = Number(button.dataset.cost) || 0;
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.1';
        input.min = '0';
        input.className = 'civil-objects-cost-input';
        input.dataset.key = button.dataset.key;
        input.value = String(Math.round(currentEur / MILLION * 100) / 100);
        input.setAttribute('aria-label', 'Cijena objekta u milijunima EUR');
        const suffix = document.createElement('span');
        suffix.className = 'civil-objects-note';
        suffix.textContent = ' mil. EUR';
        button.replaceWith(input, suffix);
        input.focus();
        input.select();

        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            const millions = Number(input.value);
            input.remove();
            suffix.remove();
            // Re-rendering is the caller's job; a cancel just puts the row back.
            if (commit && Number.isFinite(millions) && millions >= 0) {
                onCommit(input.dataset.key, Math.round(millions * MILLION));
            } else {
                onCommit(null, null);
            }
        };
        input.onkeydown = (event) => {
            if (event.key === 'Enter') { event.preventDefault(); finish(true); }
            else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        };
        input.onblur = () => finish(true);
    }

    root.__civilObjectsView = {
        render, attach, countText, objectCountText, STATION_KIND_LABELS,
        compactNameText, compactCellLabel,
        formatChainage, sortRows, plainText, SORT_KEYS, OBJECT_COLUMNS,
    };
}(typeof self !== 'undefined' ? self : this));
