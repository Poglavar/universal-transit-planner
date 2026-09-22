// Date- and location-aware sunrise/sunset for the map's compact sky clock.
// UMD keeps it usable from the classic planner and directly testable in Node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.Daylight = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DEG_TO_RAD = Math.PI / 180;
    const RAD_TO_DEG = 180 / Math.PI;
    const DEFAULT_TIME_ZONE = 'UTC';

    function zonedParts(date, timeZone) {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(date);
        return Object.fromEntries(parts
            .filter(part => part.type !== 'literal')
            .map(part => [part.type, Number(part.value)]));
    }

    function dayOfYear(parts) {
        const current = Date.UTC(parts.year, parts.month - 1, parts.day);
        const yearStart = Date.UTC(parts.year, 0, 0);
        return Math.floor((current - yearStart) / 86400000);
    }

    function timeZoneOffsetMinutes(date, timeZone, parts) {
        const localAsUtc = Date.UTC(
            parts.year,
            parts.month - 1,
            parts.day,
            parts.hour,
            parts.minute,
            parts.second,
        );
        return Math.round((localAsUtc - date.getTime()) / 60000);
    }

    // NOAA's compact solar-position approximation. Accuracy is comfortably
    // within a few minutes—far tighter than the clock widget needs.
    function solarWindow(date, lat, lng, timeZone = DEFAULT_TIME_ZONE) {
        const instant = date instanceof Date ? date : new Date(date);
        const latitude = Number(lat);
        const longitude = Number(lng);
        if (!Number.isFinite(instant.getTime())
            || !Number.isFinite(latitude)
            || !Number.isFinite(longitude)) {
            return null;
        }
        const parts = zonedParts(instant, timeZone);
        const ordinal = dayOfYear(parts);
        const daysInYear = ((parts.year % 4 === 0 && parts.year % 100 !== 0)
            || parts.year % 400 === 0) ? 366 : 365;
        const gamma = (2 * Math.PI / daysInYear) * (ordinal - 1);
        const equationOfTimeMin = 229.18 * (
            0.000075
            + 0.001868 * Math.cos(gamma)
            - 0.032077 * Math.sin(gamma)
            - 0.014615 * Math.cos(2 * gamma)
            - 0.040849 * Math.sin(2 * gamma)
        );
        const declination = 0.006918
            - 0.399912 * Math.cos(gamma)
            + 0.070257 * Math.sin(gamma)
            - 0.006758 * Math.cos(2 * gamma)
            + 0.000907 * Math.sin(2 * gamma)
            - 0.002697 * Math.cos(3 * gamma)
            + 0.00148 * Math.sin(3 * gamma);
        const latitudeRad = latitude * DEG_TO_RAD;
        const zenithRad = 90.833 * DEG_TO_RAD;
        const cosHourAngle = (
            Math.cos(zenithRad) / (Math.cos(latitudeRad) * Math.cos(declination))
        ) - Math.tan(latitudeRad) * Math.tan(declination);
        if (cosHourAngle < -1 || cosHourAngle > 1) return null;
        const hourAngleDeg = Math.acos(cosHourAngle) * RAD_TO_DEG;
        const offsetMin = timeZoneOffsetMinutes(instant, timeZone, parts);
        const solarNoonMin = 720 - 4 * longitude - equationOfTimeMin + offsetMin;
        return {
            sunriseHour: (solarNoonMin - 4 * hourAngleDeg) / 60,
            solarNoonHour: solarNoonMin / 60,
            sunsetHour: (solarNoonMin + 4 * hourAngleDeg) / 60,
            date: `${parts.year}-${String(parts.month).padStart(2, '0')}`
                + `-${String(parts.day).padStart(2, '0')}`,
        };
    }

    // Map a seasonally varying day onto the palette's canonical
    // sunrise=06:00, noon=12:00, sunset=18:00 clock.
    function paletteHour(hour, window) {
        const value = ((Number(hour) % 24) + 24) % 24;
        const sunrise = Number(window?.sunriseHour);
        const noon = Number(window?.solarNoonHour);
        const sunset = Number(window?.sunsetHour);
        if (![sunrise, noon, sunset].every(Number.isFinite)
            || !(sunrise < noon && noon < sunset)) {
            return value;
        }
        if (value >= sunrise && value <= noon) {
            return 6 + ((value - sunrise) / (noon - sunrise)) * 6;
        }
        if (value > noon && value <= sunset) {
            return 12 + ((value - noon) / (sunset - noon)) * 6;
        }
        const nightHour = value < sunrise ? value + 24 : value;
        const canonical = 18 + ((nightHour - sunset) / (sunrise + 24 - sunset)) * 12;
        return canonical >= 24 ? canonical - 24 : canonical;
    }

    return {
        DEFAULT_TIME_ZONE,
        solarWindow,
        paletteHour,
    };
}));
