(function () {
    const city = window.__TRANSIT_RUNTIME_CONFIG__?.city || {};
    const page = document.body?.dataset.page || 'planner';
    const product = 'Universal Transit Planner';
    const cityName = city.name || 'Example City';
    const branding = city.branding || {};
    const i18n = window.__transitI18n;

    document.documentElement.lang = i18n?.currentLanguage || String(city.locale || 'en').split('-')[0];
    document.title = page === 'leaderboard'
        ? (i18n?.t('leaderboardTitle', { city: cityName }) || `${cityName} — Project leaderboard`)
        : (i18n?.t('cityPlannerTitle', { city: cityName }) || `${cityName} — ${product}`);

    for (const element of document.querySelectorAll('[data-city-name]')) {
        element.textContent = cityName;
    }

    const logoLink = document.querySelector('.logo-link');
    if (logoLink) {
        logoLink.title = branding.productName || product;
        if (branding.logo) {
            logoLink.replaceChildren(Object.assign(document.createElement('img'), {
                src: branding.logo,
                alt: branding.logoAlt || '',
                className: 'sidebar-logo',
            }));
        }
    }

    const authorInput = document.getElementById('authorInput');
    if (authorInput) {
        authorInput.placeholder = i18n?.currentLanguage === 'hr'
            ? 'npr. Gradski metro'
            : 'e.g. Central metro';
    }
    const objectBrowserLink = document.getElementById('objectBrowserNavLink');
    if (objectBrowserLink && city.objectBrowser) {
        objectBrowserLink.hidden = false;
        objectBrowserLink.href = city.objectBrowser.path;
        objectBrowserLink.textContent = i18n?.currentLanguage === 'hr'
            ? 'Željeznički objekti'
            : 'Railway objects';
    }
    const terrainDatum = document.querySelector('[data-terrain-datum]');
    if (terrainDatum) {
        terrainDatum.textContent = city.providerLabels?.terrainDatum
            || (i18n?.currentLanguage === 'hr' ? 'Izvor terena' : 'Terrain source');
    }

    const heading = page === 'leaderboard'
        ? document.querySelector('.page-header h1')
        : document.querySelector('.sidebar-header h2');
    if (heading) {
        heading.textContent = page === 'leaderboard'
            ? `${cityName} — ${i18n?.currentLanguage === 'hr' ? 'ljestvica projekata' : 'Project leaderboard'}`
            : `${cityName} ${i18n?.currentLanguage === 'hr' ? 'planer' : 'planner'}`;
    }

    const infoContent = document.querySelector('#infoModal .info-modal-content');
    const attributionSection = window.__transitProviderAttribution?.section(
        city.attributions,
        i18n?.currentLanguage === 'hr' ? 'Izvori i licence' : 'Sources and licences',
    );
    if (infoContent && attributionSection && !infoContent.querySelector('[data-provider-attributions]')) {
        infoContent.insertAdjacentHTML('beforeend', attributionSection);
    }
})();
