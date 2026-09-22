// Bounded, retryable JSON fetch for terrain profiles.
//
// UMD: the planner gets window.__terrainProfileFetch; node tests require the
// same implementation. Fetch/timer/AbortController implementations are
// injectable so failure paths are deterministic in headless tests.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.__terrainProfileFetch = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DEFAULT_TIMEOUT_MS = 15_000;
    const DEFAULT_ATTEMPTS = 3;

    function responseError(status) {
        const error = new Error(`terrain profile HTTP ${status}`);
        error.status = Number(status);
        return error;
    }

    function retryable(error) {
        const status = Number(error?.status);
        if (Number.isFinite(status)) {
            return status === 408 || status === 425 || status === 429 || status >= 500;
        }
        // Fetch rejects network failures with TypeError and aborts with
        // AbortError. Unknown thrown errors are not retried: a JSON parser bug
        // or application exception should surface immediately.
        return error?.name === 'AbortError' || error instanceof TypeError;
    }

    async function fetchJsonWithRetry(fetchImpl, url, init = {}, options = {}) {
        if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
        const attempts = Math.max(1, Math.floor(Number(options.attempts) || DEFAULT_ATTEMPTS));
        const timeoutMs = Math.max(1, Math.floor(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
        const AbortControllerImpl = options.AbortControllerImpl || globalThis.AbortController;
        const setTimeoutFn = options.setTimeoutFn || globalThis.setTimeout;
        const clearTimeoutFn = options.clearTimeoutFn || globalThis.clearTimeout;
        let finalError = null;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const controller = new AbortControllerImpl();
            const timeoutId = setTimeoutFn(() => controller.abort(), timeoutMs);
            try {
                const response = await fetchImpl(url, { ...init, signal: controller.signal });
                if (!response.ok) throw responseError(response.status);
                return await response.json();
            } catch (error) {
                finalError = error;
                if (attempt >= attempts || !retryable(error)) throw error;
                options.onRetry?.({ attempt, attempts, error });
            } finally {
                clearTimeoutFn(timeoutId);
            }
        }
        throw finalError || new Error('terrain profile request failed');
    }

    return {
        fetchJsonWithRetry,
        retryable,
        DEFAULT_TIMEOUT_MS,
        DEFAULT_ATTEMPTS,
    };
}));
