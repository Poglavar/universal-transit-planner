// The chainage dialog: one row per inter-station section, with what we computed
// from the reconstruction beside what HŽ Infrastruktura publishes.
//
// Rendering only. Everything numeric comes from planner-grade/line-chainage.js,
// which is unit-tested; this file must not compute a figure of its own, or the
// table and the model could disagree.

(function (root) {
    'use strict';

    const KM = metres => (metres / 1000).toFixed(2);
    const MIN = seconds => (seconds / 60).toFixed(1);
    const NUM = (value, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : '–');

    // Escapes quotes as well as angle brackets so the output is safe inside
    // title="..." attributes, not only in text nodes.
    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // An official figure inherited from an enclosing section is marked, and its
    // source named in the title, so the table never implies the annex names this
    // stretch when it does not.
    function officialCell(value, inherited, sourceName, suffix = '') {
        if (value == null) return '<td class="lcd-official lcd-missing">–</td>';
        const mark = inherited ? '<span class="lcd-inherited" aria-hidden="true">*</span>' : '';
        const title = inherited
            ? ` title="Iz nadređene službene dionice: ${escapeHtml(sourceName || '')}"`
            : '';
        return `<td class="lcd-official"${title}>${escapeHtml(value)}${escapeHtml(suffix)}${mark}</td>`;
    }

    function structureSummary(structures) {
        const parts = [];
        if (structures.tunnels) {
            parts.push(`${structures.tunnels} tunel${structures.tunnels === 1 ? '' : 'a'}`
                + ` (${Math.round(structures.tunnelLengthM)} m)`);
        }
        if (structures.bridges) {
            parts.push(`${structures.bridges} most${structures.bridges === 1 ? '' : 'ova'}`
                + ` (${Math.round(structures.bridgeLengthM)} m)`);
        }
        if (Number.isFinite(structures.deepestCutM) && structures.deepestCutM < -1) {
            parts.push(`usjek ${Math.abs(structures.deepestCutM).toFixed(1)} m`);
        }
        if (Number.isFinite(structures.highestFillM) && structures.highestFillM > 1) {
            parts.push(`nasip ${structures.highestFillM.toFixed(1)} m`);
        }
        return parts.length ? parts.join(' · ') : 'na terenu';
    }

    function crossingSummary(levelCrossings) {
        if (!levelCrossings.total) return '–';
        const byProtection = levelCrossings.byProtection || {};
        const detail = Object.entries(byProtection)
            .map(([kind, count]) => `${count} ${kind}`)
            .join(', ');
        return `<span title="${escapeHtml(detail)}">${levelCrossings.total}</span>`;
    }

    function electricalValue(value, unit) {
        if (!Number.isFinite(value)) return null;
        if (unit === 'V' && Math.abs(value) >= 1000) {
            return NUM(value / 1000, value % 1000 ? 1 : 0) + ' kV';
        }
        return NUM(value, value % 1 ? 1 : 0) + ' ' + unit;
    }

    function electrificationSummary(electrification) {
        if (!electrification || electrification.status === 'unknown') return '–';
        if (electrification.status === 'none') return 'nije';
        const systems = [];
        for (const voltage of electrification.voltages || []) {
            systems.push(electricalValue(voltage, 'V'));
        }
        for (const frequency of electrification.frequencies || []) {
            systems.push(electricalValue(frequency, 'Hz'));
        }
        const system = systems.filter(Boolean).join(' · ');
        if (electrification.status === 'partial') {
            return KM(electrification.electrifiedLengthM) + ' / '
                + KM(electrification.lengthM) + ' km' + (system ? ' · ' + system : '');
        }
        return system || 'da';
    }

    function electrificationHeader(electrification) {
        if (!electrification || electrification.status === 'unknown') {
            return 'elektrifikacija nepoznata';
        }
        if (electrification.status === 'none') return 'nije elektrificirana';
        return KM(electrification.electrifiedLengthM) + ' km elektrificirano';
    }

    function electrificationTitle(electrification) {
        return (electrification?.runs || [])
            .filter(run => ['contact_line', 'rail'].includes(run.electrified))
            .map(run => {
                const values = [
                    electricalValue(run.voltage, 'V'),
                    electricalValue(run.frequency, 'Hz'),
                ].filter(Boolean).join(' · ');
                return 'km ' + KM(run.fromM) + '–' + KM(run.toM)
                    + (values ? ' (' + values + ')' : '');
            }).join('; ');
    }

    function electrificationCell(electrification) {
        const title = electrificationTitle(electrification);
        const titleAttribute = title ? ' title="' + escapeHtml(title) + '"' : '';
        const active = electrification?.electrifiedLengthM > 0 ? ' lcd-electrified' : '';
        return '<td class="lcd-electrification' + active + '"' + titleAttribute + '>'
            + escapeHtml(electrificationSummary(electrification)) + '</td>';
    }

    function electrificationRunsHtml(line) {
        const title = electrificationTitle(line.electrification);
        if (!title) return '';
        return '<div class="lcd-electrification-runs"><span aria-hidden="true"></span>'
            + 'Elektrificirano: ' + escapeHtml(title) + '</div>';
    }

    function officialSpeedLabel(official) {
        const low = Number(official?.restrictedSpeedKph);
        const high = Number(official?.permittedSpeedKph);
        const hasLow = Number.isFinite(low) && low > 0;
        const hasHigh = Number.isFinite(high) && high > 0;
        if (hasLow && hasHigh && low !== high) return `${Math.min(low, high)}–${Math.max(low, high)}`;
        if (hasHigh) return String(high);
        if (hasLow) return String(low);
        return null;
    }

    function rowHtml(section, index) {
        const official = section.official || {};
        const speed = section.speed || {};
        return `
        <tr class="lcd-row" data-section="${index}">
            <td class="lcd-name">${escapeHtml(section.from)} – ${escapeHtml(section.to)}</td>
            <td class="lcd-num">${KM(section.fromM)}</td>
            <td class="lcd-num">${KM(section.lengthM)}</td>
            <td class="lcd-num">${NUM(section.averageGradePermille, 1)}</td>
            <td class="lcd-num">${NUM(section.maxGradePermille, 1)}</td>
            ${officialCell(official.rulingGradePermille, official.rulingGradeInherited,
        official.rulingGradeSection, '‰')}
            ${officialCell(officialSpeedLabel(official), official.speedInherited,
        official.speedSection)}
            <td class="lcd-num">${NUM(speed.maxPossibleSpeedKph)}</td>
            <td class="lcd-num">${NUM(speed.averageSpeedKph)}</td>
            <td class="lcd-num">${MIN(speed.seconds || 0)}</td>
            ${electrificationCell(section.electrification)}
            <td class="lcd-num">${crossingSummary(section.levelCrossings || { total: 0 })}</td>
            <td class="lcd-structures">${escapeHtml(structureSummary(section.structures || {}))}</td>
        </tr>`;
    }

    function tableHtml(line) {
        const seamNote = (line.seams || []).some(seam => seam.seamM > 5)
            ? `<p class="lcd-note lcd-warn">Spoj segmenata nije točan: `
                + `${line.seams.filter(s => s.seamM > 5).map(s => `${s.seamM.toFixed(0)} m`).join(', ')}</p>`
            : '';
        // Not a warning: a reconstruction that meets this one only at a terminus is
        // a DIFFERENT line (Zagreb Gk – Hrvatski Leskovac shares the station, not
        // the route), and joining it would double the line back on itself. Saying
        // so plainly beats an alarming "failed to join".
        const unjoinedNote = (line.unjoined || []).length
            ? `<p class="lcd-note">Nije uključeno kao nastavak — druga pruga na istom kolodvoru:
                ${escapeHtml(line.unjoined.join(', '))}</p>`
            : '';
        const timingBasis = line.totals.officialSpeedLengthM > 0
            ? 'uz službena ograničenja'
            : 'prema rekonstruiranoj geometriji';
        return `
        <div class="lcd-head">
            <div class="lcd-title">
                <strong>${escapeHtml((line.refs || []).join(' + ') || 'pruga')}</strong>
                <span>${KM(line.lengthM)} km · ${MIN(line.totals.seconds)} min u prolazu (${timingBasis})
                    · ${line.sections.length} dionica
                    · ${electrificationHeader(line.electrification)}
                    · ${line.totals.levelCrossings} prijelaza
                    · ${line.totals.tunnels} tunela / ${line.totals.bridges} mostova</span>
            </div>
            <div class="lcd-from">${escapeHtml((line.segments || []).map(s => s.name).join('  +  '))}</div>
            ${electrificationRunsHtml(line)}
            ${seamNote}${unjoinedNote}
        </div>
        <div class="lcd-scroll">
        <table class="lcd-table">
            <thead>
                <tr>
                    <th rowspan="2">Dionica</th>
                    <th rowspan="2">km</th>
                    <th rowspan="2">Duljina<br>km</th>
                    <th colspan="2">Nagib ‰</th>
                    <th colspan="2" class="lcd-official-group">Službeno</th>
                    <th colspan="2">Vožnja km/h</th>
                    <!-- Its own column, not a third "Moguće" one: minutes under a
                         speed group read as a 4 km/h minimum speed. -->
                    <th rowspan="2">Vrijeme<br>min</th>
                    <th rowspan="2">Elektrifikacija</th>
                    <th rowspan="2">Prijelazi</th>
                    <th rowspan="2">Objekti</th>
                </tr>
                <tr>
                    <th>sred.</th><th>maks.</th>
                    <th class="lcd-official-group">mjerodavni</th>
                    <th class="lcd-official-group">brzina</th>
                    <th>teh. maks.</th><th>prosjek</th>
                </tr>
            </thead>
            <tbody>${line.sections.map(rowHtml).join('')}</tbody>
        </table>
        </div>
        <p class="lcd-note">
            <span class="lcd-inherited">*</span> preuzeto iz nadređene službene dionice —
            službeni prilozi dijele prugu samo na kolodvore, a ova tablica i na stajališta.
            Stupci „Službeno“ su iz Izvješća o mreži (prilog 2.18 mjerodavni nagib, 2.13 dopuštena brzina);
            raspon poput 80–90 znači da prilog unutar te dionice objavljuje više ograničenja.
            „Teh. maks.“ je iz rekonstruirane geometrije (zavoji i nagibi), bez signalizacije i stanja
            pruge. „Prosjek“ i vrijeme poštuju službenu brzinu gdje je objavljena; dok službene
            kilometarske poddionice ne registriramo na rekonstruiranu kilometražu, za cijeli prikazani
            red konzervativno se primjenjuje niža vrijednost objavljenog raspona.
        </p>`;
    }

    function open(line, options = {}) {
        if (!line || !line.sections?.length) return null;
        close();
        const overlay = document.createElement('div');
        overlay.className = 'lcd-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', options.title || 'Kilometraža pruge');
        overlay.innerHTML = `
            <div class="lcd-modal">
                <button class="lcd-close" type="button" aria-label="Zatvori">×</button>
                ${tableHtml(line)}
            </div>`;
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay || event.target.closest('.lcd-close')) close();
        });
        document.addEventListener('keydown', onKeydown);
        document.body.appendChild(overlay);
        overlay.querySelector('.lcd-close')?.focus();
        return overlay;
    }

    function onKeydown(event) {
        if (event.key === 'Escape') close();
    }

    function close() {
        document.removeEventListener('keydown', onKeydown);
        document.querySelectorAll('.lcd-overlay').forEach(node => node.remove());
    }

    root.__lineChainageDialog = {
        open,
        close,
        tableHtml,
        structureSummary,
        electrificationSummary,
        electrificationHeader,
        electrificationTitle,
        officialSpeedLabel,
    };
}(typeof self !== 'undefined' ? self : this));
