// Shared simulation clock for all transit animations (rail sim, tram sim, player-drawn lines).
// Provides a single time source and speed multiplier. UI lives in the sim-panel defined in HTML.

(function () {
    'use strict';

    const SPEED_PRESETS = [1, 2, 4, 8, 16, 32, 64, 128, 360];
    const DEFAULT_SPEED_INDEX = 2; // 4x

    let speedIndex = DEFAULT_SPEED_INDEX;
    let speedMultiplier = SPEED_PRESETS[speedIndex];
    let paused = false;

    // Anchor-based time: sim time = anchorSimSec + (wallNow - anchorWallSec) * speed.
    // The hot path uses performance.now(); formatting in the manifest timezone
    // is only needed once to choose the initial time of day.
    let anchorWallSec = null;
    let anchorSimSec = null;

    function getWallElapsedSec() {
        return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    }

    function getLocalSecSinceMidnight() {
        const now = new Date();
        const timeZone = window.__TRANSIT_RUNTIME_CONFIG__?.city?.timezone || 'UTC';
        const localTime = now.toLocaleString('en-US', { timeZone, hour12: false });
        const parts = localTime.split(', ')[1].split(':');
        const h = parseInt(parts[0]) % 24;
        const m = parseInt(parts[1]);
        const s = parseInt(parts[2]);
        return h * 3600 + m * 60 + s + now.getMilliseconds() / 1000;
    }

    function initAnchor() {
        anchorWallSec = getWallElapsedSec();
        anchorSimSec = getLocalSecSinceMidnight();
    }

    function getSimTimeSec() {
        if (anchorWallSec === null) initAnchor();
        if (paused) return anchorSimSec;
        const elapsed = getWallElapsedSec() - anchorWallSec;
        return anchorSimSec + elapsed * speedMultiplier;
    }

    function getSimHour() {
        const sec = getSimTimeSec();
        return ((sec % 86400) + 86400) % 86400 / 3600;
    }

    function getSpeedMultiplier() {
        return paused ? 0 : speedMultiplier;
    }

    function reanchor() {
        if (anchorWallSec !== null) {
            anchorSimSec = getSimTimeSec();
            anchorWallSec = getWallElapsedSec();
        }
    }

    function setSpeedIndex(idx) {
        reanchor();
        speedIndex = Math.max(0, Math.min(SPEED_PRESETS.length - 1, idx));
        speedMultiplier = SPEED_PRESETS[speedIndex];
        updateSpeedLabel();
    }

    function setPaused(p) {
        if (p === paused) return;
        reanchor();
        paused = p;
        const panel = document.getElementById('simPanel');
        if (panel) panel.style.display = paused ? 'none' : '';
    }

    // Jumps the simulated clock to the given hour-of-day (0-24, fractional OK).
    // Wall-clock anchor is reset to now so time continues forward from the
    // jump point at the current speed multiplier.
    function setSimHour(hour) {
        if (!isFinite(hour)) return;
        const h = ((hour % 24) + 24) % 24;
        if (anchorWallSec === null) initAnchor();
        anchorSimSec = h * 3600;
        anchorWallSec = getWallElapsedSec();
    }

    function formatHourMinute(hour) {
        const h = Math.floor(hour) % 24;
        const m = Math.floor((hour % 1) * 60);
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }

    // Accepts "HH:MM", "HH:MM:SS", "HH" (integer hour), or decimal "HH.H".
    // Returns a number in [0, 24) or null when unparseable.
    function parseHourInput(text) {
        const s = String(text || '').trim();
        if (!s) return null;
        const colon = s.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
        if (colon) {
            const h = parseInt(colon[1], 10);
            const m = parseInt(colon[2], 10);
            const sec = colon[3] ? parseInt(colon[3], 10) : 0;
            if (h >= 0 && h < 24 && m >= 0 && m < 60 && sec >= 0 && sec < 60) {
                return h + m / 60 + sec / 3600;
            }
            return null;
        }
        const num = parseFloat(s);
        if (isFinite(num) && num >= 0 && num < 24) return num;
        return null;
    }

    function bindTimeDisplay() {
        const display = document.getElementById('timeClockDisplay');
        if (!display) return;
        display.style.cursor = 'pointer';
        display.title = 'Klikni za promjenu vremena (HH:MM)';
        display.addEventListener('click', () => {
            // dataset.editing is also read by transit.js's per-frame clock
            // refresh to avoid clobbering the input while it's focused.
            if (display.dataset.editing === 'true') return;
            display.dataset.editing = 'true';

            const current = display.textContent || formatHourMinute(getSimHour());
            const input = document.createElement('input');
            input.type = 'text';
            input.value = current;
            input.maxLength = 8;
            input.setAttribute('aria-label', 'Simulirano vrijeme');
            input.style.cssText = [
                'width: 56px',
                'padding: 0 4px',
                'font: inherit',
                'color: inherit',
                'background: rgba(15,23,42,0.85)',
                'border: 1px solid rgba(255,255,255,0.35)',
                'border-radius: 4px',
                'text-align: center',
                'box-sizing: content-box',
            ].join(';');
            display.textContent = '';
            display.appendChild(input);
            input.focus();
            input.select();

            const finish = (commit) => {
                if (display.dataset.editing !== 'true') return;
                if (commit) {
                    const parsed = parseHourInput(input.value);
                    if (parsed != null) setSimHour(parsed);
                }
                delete display.dataset.editing;
                display.textContent = formatHourMinute(getSimHour());
            };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
                else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
            });
            input.addEventListener('blur', () => finish(true));
        });
    }

    function speedUp() { setSpeedIndex(speedIndex + 1); }
    function speedDown() { setSpeedIndex(speedIndex - 1); }

    // ─── UI Binding ────────────────────────────────────────────────────────

    let speedEl = null;

    function bindUI() {
        speedEl = document.getElementById('simSpeedLabel');
        const downBtn = document.getElementById('simSpeedDown');
        const upBtn = document.getElementById('simSpeedUp');
        if (downBtn) downBtn.addEventListener('click', speedDown);
        if (upBtn) upBtn.addEventListener('click', speedUp);

        const toggle = document.getElementById('toggleTimeFlow');
        if (toggle) {
            toggle.addEventListener('change', () => setPaused(!toggle.checked));
        }

        bindTimeDisplay();
        updateSpeedLabel();
    }

    function updateSpeedLabel() {
        if (speedEl) speedEl.textContent = speedMultiplier + 'x';
    }

    if (document.getElementById('simSpeedLabel')) {
        bindUI();
    } else {
        document.addEventListener('DOMContentLoaded', bindUI);
    }

    window.simClock = {
        getSimTimeSec,
        getSimHour,
        getSpeedMultiplier,
        speedUp,
        speedDown,
        setPaused,
        setSimHour,
        isPaused: () => paused,
        setSimActive: () => {},
    };
})();
