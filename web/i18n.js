(function (root, factory) {
    const api = factory(root || {});
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__transitI18n = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const STORAGE_KEY = 'utp-language';
    const SUPPORTED_LANGUAGES = Object.freeze(['en', 'hr']);

    const MESSAGES = Object.freeze({
        en: Object.freeze({
            cityPlannerTitle: '{city} — Universal Transit Planner',
            leaderboardTitle: '{city} — Project leaderboard',
            projectLoaded: 'Project “{name}” loaded.',
            loadingProject: 'Loading project…',
            confirm: 'Confirm',
            cancel: 'Cancel',
            close: 'Close',
        }),
        hr: Object.freeze({
            cityPlannerTitle: '{city} — Planer javnog prijevoza',
            leaderboardTitle: '{city} — Ljestvica projekata',
            projectLoaded: 'Projekt „{name}” učitan.',
            loadingProject: 'Učitavam projekt…',
            confirm: 'Potvrdi',
            cancel: 'Odustani',
            close: 'Zatvori',
        }),
    });

    // Compatibility catalogue for the current extracted UI. New code should
    // call t() or use data-i18n instead of adding another source-language
    // literal. Exact matching prevents project names and imported data from
    // being translated accidentally.
    const ENGLISH_TEXT = Object.freeze({
        'Ljestvica': 'Leaderboard',
        'Planer': 'Planner',
        'Info i upute': 'Help',
        'Dnevnik': 'Activity log',
        'Dnevnik sesije': 'Session log',
        'Kilometraža': 'Chainage',
        'Kilometraža projekta': 'Project chainage',
        'Stanovnici': 'Population',
        'Radna mjesta': 'Jobs',
        'Ostale pruge': 'Other railways',
        'Vlak': 'Rail',
        'Tramvaj': 'Tram',
        'Reljef': 'Terrain',
        'Reljef nije dostupan': 'Terrain unavailable',
        'Preglednik': '3D viewer',
        'Protok vremena': 'Time simulation',
        'Razmaci stanica (plan)': 'Station spacing',
        'Brojke nad stanicama': 'Station demand labels',
        'Vrijeme hodanja:': 'Walking time:',
        'isklj.': 'off',
        'Širina kolosijeka:': 'Track gauge:',
        '🚊 Uskotračna (1000 mm)': '🚊 Metre gauge (1000 mm)',
        '🚇 Normalna (1435 mm)': '🚇 Standard gauge (1435 mm)',
        'Cijena za površinu; razine mijenjate na točkama trase (−1/0/+1).': 'Surface alignment price; change levels at track nodes (−1/0/+1).',
        'Obriši': 'Delete',
        'Zatvori': 'Close',
        'Doseg pjesaka': 'Walking catchment',
        'Doseg pješaka': 'Walking catchment',
        'Stanovnika u dosegu': 'Population reached',
        'Radnih mjesta u dosegu': 'Jobs reached',
        'Trase': 'Tracks',
        'Linije': 'Lines',
        'Sazetak': 'Summary',
        'Sažetak': 'Summary',
        'Ukupna duljina:': 'Total length:',
        'Ukupna cijena:': 'Total cost:',
        'Stanica:': 'Stations:',
        'Stanica': 'Stations',
        'Stanovnika u dosegu:': 'Population reached:',
        'Stan. s više stanica:': 'Population served by multiple stations:',
        'Radnih mjesta u dosegu:': 'Jobs reached:',
        'Rad. mj. s više stanica:': 'Jobs served by multiple stations:',
        'Cijena/stanovnik:': 'Cost/person:',
        'Cijena/radno mj.:': 'Cost/job:',
        'Spremi': 'Save',
        'Podijeli': 'Share',
        'Link na projekt:': 'Project link:',
        'Kopiraj': 'Copy',
        'Kopirano!': 'Copied!',
        'Slika za dijeljenje:': 'Share image:',
        'Preuzmi screenshot': 'Download screenshot',
        'Kopiraj screenshot': 'Copy screenshot',
        'Screenshot hvata trenutno vidljiv prikaz projekta, za dijeljenje po forumima i porukama.': 'The screenshot captures the currently visible project view for sharing in messages and discussions.',
        'Računam...': 'Calculating…',
        'Računam…': 'Calculating…',
        'Učitavanje...': 'Loading…',
        'Učitavam...': 'Loading…',
        'Učitavam…': 'Loading…',
        'Spremi projekt': 'Save project',
        'Naziv projekta:': 'Project name:',
        'Odustani': 'Cancel',
        'Potvrdi': 'Confirm',
        'Očisti': 'Clear',
        'Objekti na mreži': 'Structures on the network',
        'Potvrda': 'Confirmation',
        'Reljef · m n. m.': 'Terrain · m above sea level',
        '↻ Izravnaj između čvorova': '↻ Recalculate between nodes',
        '⟲ Poništi izmjene': '⟲ Undo changes',
        '📋 Objekti': '📋 Structures',
        '⛰ 3D pregled': '⛰ 3D view',
        'Vijadukt:': 'Viaduct:',
        'Tunel:': 'Tunnel:',
        'm iznad terena': 'm above ground',
        'm ispod terena': 'm below ground',
        'Računam visinski profil…': 'Calculating elevation profile…',
        '＋ Nova trasa': '＋ New track',
        '＋ Nova stanica': '＋ New station',
        '✎ Uredi mrežu': '✎ Edit network',
        '⚡ Uredi elektrifikaciju': '⚡ Edit electrification',
        '🔗 Spoji postojeću prugu': '🔗 Connect existing railway',
        '✓ Završi': '✓ Finish',
        '3D prikaz stanice': '3D station view',
        'Kraj linije': 'End of line',
        'Odaberite nastavak vožnje.': 'Choose where to continue.',
        'Okreni se i vrati': 'Turn around and return',
        'Nema zapisa.': 'No entries yet.',
        'Nema linija': 'No lines',
        'Doseg isključen.': 'Catchment disabled.',
        'Visina nedostupna': 'Elevation unavailable',
        'Pokušajte ponovno': 'Try again',
        'Prikaži kartu': 'Show map',
        'Učitavam okolinu…': 'Loading surroundings…',
        'Postavi cijene': 'Set prices',
        'Lokalne cijene gradnje': 'Local construction prices',
        'Vrati zadano': 'Restore defaults',
        'Spremi cijene': 'Save prices',
        'Rangirani': 'Ranked',
        'Nerangirani': 'Unranked',
        'Postojeće': 'Existing',
        'Nema projekata.': 'No projects.',
        'Mreža': 'Network',
        'Autor': 'Author',
        'Duljina': 'Length',
        'Cijena': 'Cost',
        'Broj veza': 'Transfers',
        'Stan.': 'Pop.',
        'Radna mj.': 'Jobs',
        'EUR/stan.': 'EUR/person',
        'EUR/r.mj.': 'EUR/job',
        'Popularnost': 'Popularity',
        'Dodano': 'Added',
        'Podaci': 'Data',
        'Pruga': 'Railway',
        'Oznaka': 'Code',
        'Lokacija': 'Location',
        'Stanje': 'Status',
        'Izvoz': 'Export',
        'Popis objekata': 'Structure list',
        'Računam…': 'Calculating…',
        'Bez podataka o dosegu': 'No catchment data',
        'Čeka izračun': 'Waiting for calculation',
        'Objekt': 'Structure',
        'Vrsta': 'Type',
        'Visina': 'Height',
        'Stanice': 'Stations',
        'Ravni teren': 'At grade',
        '🛤️ Ravni teren': '🛤️ At grade',
        '🏘️ Stanica': '🏘️ Station',
        'Uskotračna (1000 mm)': 'Metre gauge (1000 mm)',
        'objekata': 'structures',
        'Nema objekata.': 'No structures.',
        'Mreža još nema nijednu trasu.': 'The network does not have any tracks yet.',
        'Modul objekata nije učitan.': 'The structures module is not loaded.',
        'Nema rekonstruiranih postojećih pruga.': 'No reconstructed existing railways.',
        'Nema nerangiranih projekata.': 'No unranked projects.',
        'Kreirajte prvi!': 'Create the first one!',
        'Površinska': 'Surface',
        'površinska': '· surface',
        'podzemna': '· underground',
        'natkrivena': '· covered',
        'u usjeku': '· in cutting',
        'nadzemna': '· elevated',
        'nadzemno': 'overground',
        'podzemno': 'underground',
        'površina': 'surface',
        'nadvožnjak': 'elevated',
        'Tunel': 'Tunnel',
        'Usjek': 'Cutting',
        'Nasip': 'Embankment',
        'Vijadukt': 'Viaduct',
        'Presjedanje': 'Transfer',
        'Remiza': 'Depot',
        'dubina': 'depth',
        'visina': 'height',
        'Stacionaža': 'Chainage',
        'Duljina / količina': 'Length / quantity',
        'Jedinična cijena': 'Unit price',
        'Ukupno': 'Total',
        'Sažetak po vrsti': 'Summary by type',
        'Službeno': 'Official',
        'Vožnja km/h': 'Operating speed km/h',
        'Građevine': 'Structures',
        'Nagib': 'Grade',
        'Ovaj projekt nije moguće uređivati.': 'This project cannot be edited.',
        'Ovaj projekt nije moguće uređivati ni spremati.': 'This project cannot be edited or saved.',
        'Ne mogu dohvatiti teren za uređivanje visine.': 'Terrain could not be loaded for elevation editing.',
        'Ne mogu dohvatiti teren za preračun visine.': 'Terrain could not be loaded to recalculate the profile.',
        'Visinski profil preračunat automatski.': 'Elevation profile recalculated automatically.',
        'Prvo odaberite trasu na karti.': 'Select a track on the map first.',
        'Uređivanje elektrifikacije završeno.': 'Electrification editing finished.',
        'Spajanje na postojeću prugu isključeno.': 'Connection to the existing railway disabled.',
        'Linija otkazana — potrebne su barem 2 stanice.': 'Line cancelled — at least two stations are required.',
        'Linija otkazana.': 'Line cancelled.',
        'Ime stanice spremljeno.': 'Station name saved.',
        'Ime stanice uklonjeno.': 'Station name removed.',
        'Učitavanje reljefne podloge nije uspjelo.': 'Terrain layer could not be loaded.',
        'Reljefna podloga uključena — klik na kartu prikazuje nadmorsku visinu.': 'Terrain layer enabled — click the map to inspect elevation.',
        'Učitavanje željezničkih stanica nije uspjelo.': 'Railway stations could not be loaded.',
        'Ostale pruge su skrivene na karti i u 3D prikazu.': 'Other railways are hidden on the map and in 3D.',
        'Učitavanje drugih željezničkih projekata nije uspjelo.': 'Other railway projects could not be loaded.',
        'Učitavanje tramvajskih stanica nije uspjelo.': 'Tram stops could not be loaded.',
        'Odabir raspona je poništen.': 'Range selection cancelled.',
        'Otvaranje kabine nije uspjelo.': 'The cab could not be opened.',
        'Otvaranje 3D prikaza stanice nije uspjelo.': 'The station 3D view could not be opened.',
        'Otvaranje 3D šetnje nije uspjelo.': 'The 3D walk could not be opened.',
        'Kliknite bliže trasi na kojoj želite postaviti stanicu.': 'Click closer to the track where you want to place the station.',
        'Ova pruga nema riješeni visinski profil.': 'This railway has no solved elevation profile.',
        'Nema dovoljno stanica na ovoj pruzi za kilometražu.': 'This railway has too few stations for chainage.',
        'Izračun kilometraže nije uspio.': 'Chainage calculation failed.',
        'Postavljam stanicu...': 'Placing station…',
        'Pričekajte prije ponovnog spremanja.': 'Please wait before saving again.',
        'Dodajte barem jednu liniju prije spremanja (grupirajte stanice u liniju).': 'Add at least one service line before saving.',
        'Pokretanje nove trase otkazano.': 'New track cancelled.',
        'Crtanje trase isključeno.': 'Track drawing disabled.',
        'Postavljanje stanica isključeno.': 'Station placement disabled.',
        'Nema vlaka za kabinu — dodajte vlak na liniju.': 'No vehicle is available for the cab — add one to the line.',
        'Spremam projekt...': 'Saving project…',
        'Spremanje nije uspjelo.': 'Saving failed.',
        'Nespremljene promjene — spremi projekt za dijeljenje.': 'There are unsaved changes — save the project before sharing.',
        'Link kopiran u međuspremnik.': 'Link copied to the clipboard.',
        'Kopiranje linka nije uspjelo.': 'The link could not be copied.',
        'Učitavam projekt...': 'Loading project…',
        'Učitavam projekt i ponovno računam doseg stanica...': 'Loading project and recalculating station catchments…',
    });

    const ENGLISH_ATTRIBUTES = Object.freeze({
        'Otvori/zatvori izbornik': 'Open/close menu',
        'Spremite projekt da biste ga otvorili u pregledniku reljefa': 'Save the project before opening it in the 3D viewer',
        'Zatvori info prozor': 'Close help',
        'Odabrani objekt': 'Selected object',
        'Zatvori dnevnik': 'Close activity log',
        'Zatvori popis objekata': 'Close structures list',
        'Popis objekata na mreži': 'List structures on the network',
        'Postavke lijepljenja visina': 'Elevation snapping settings',
        'Zatvori postavke': 'Close settings',
        'Alati za uređivanje mreže': 'Network editing tools',
        'Dodavanje': 'Add',
        'Uređivanje': 'Edit',
        'Odaberite širinu kolosijeka': 'Choose track gauge',
        'Uskotračna (1000 mm)': 'Metre gauge (1000 mm)',
        'Normalna (1435 mm)': 'Standard gauge (1435 mm)',
        'Nova uskotračna trasa, 1000 milimetara': 'New metre-gauge track, 1000 millimetres',
        'Nova trasa normalne širine, 1435 milimetara': 'New standard-gauge track, 1435 millimetres',
        'Zatvori 3D prikaz': 'Close 3D view',
        'Ljestvica projekata': 'Project leaderboard',
        'Postojeće pruge': 'Existing railways',
        'Vrati na cijenu iz modela': 'Restore model price',
        'Ručno upisana cijena — klik za izmjenu': 'Manual price — click to edit',
        'Klik za ručni upis cijene': 'Click to enter a manual price',
        'Prikaži na karti': 'Show on map',
    });

    const ENGLISH_INFO_HTML = `
        <section>
            <h4>Design a network</h4>
            <ol>
                <li>Click the map to inspect the <strong>walking catchment</strong> from a location.</li>
                <li>Open the editing tools and start a <strong>new track</strong>.</li>
                <li>Add alignment nodes, then finish with the toolbar or a double click.</li>
                <li>Click near a track to <strong>place a station</strong>; drag it along the alignment to reposition it.</li>
                <li>Select a track to move nodes, change levels and inspect its elevation profile.</li>
                <li>Create a <strong>service line</strong> at a depot and select the stations it serves.</li>
                <li>Add vehicles from the line popup to start the service simulation.</li>
            </ol>
        </section>
        <section>
            <h4>Terrain and civil engineering</h4>
            <p>The map is a 2D editing surface backed by 3D terrain and vertical alignment data. The profile editor shows chainage, ground elevation, designed grade, tunnels, cuttings, embankments and viaducts.</p>
            <p>Terrain quality depends on the selected city provider. Global DEM results are preliminary; local LiDAR or bare-earth DTM sources can provide engineering-grade detail where available.</p>
        </section>
        <section>
            <h4>Simulation and 3D</h4>
            <p>Service begins automatically when a line has vehicles. Passenger demand follows the time of day and the population and jobs reached by each station.</p>
            <ul>
                <li><strong>Time simulation</strong> pauses or resumes vehicles and passenger demand.</li>
                <li><strong>Station demand labels</strong> compare offered capacity with waiting passengers.</li>
                <li><strong>3D view</strong> opens the same designed network in Station3D for walking, riding and infrastructure inspection.</li>
            </ul>
        </section>
        <section>
            <h4>Data and availability</h4>
            <p>Each city manifest declares its routing, terrain, demand, reference-transit, persistence and 3D providers. Controls are hidden when the selected deployment does not provide the underlying data or service.</p>
            <ul>
                <li><a href="https://www.openstreetmap.org/" target="_blank" rel="noopener"><strong>OpenStreetMap</strong></a> provides the base map and open geographic data.</li>
                <li><a href="https://github.com/valhalla/valhalla" target="_blank" rel="noopener"><strong>Valhalla</strong></a> can provide walking catchments.</li>
                <li><a href="https://leafletjs.com/" target="_blank" rel="noopener"><strong>Leaflet</strong></a> powers the map editor.</li>
                <li><a href="https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM" target="_blank" rel="noopener"><strong>Copernicus DEM</strong></a> provides the default global terrain baseline.</li>
            </ul>
        </section>
        <section>
            <h4>Save and share</h4>
            <p>When persistence is available, save a proposal, compare it on the leaderboard, and share a direct project link or screenshot.</p>
        </section>`;

    const CROATIAN_INFO_HTML = `
        <section>
            <h4>Projektiranje mreže</h4>
            <ol>
                <li>Kliknite kartu za provjeru <strong>pješačkog dosega</strong> lokacije.</li>
                <li>Otvorite alate za uređivanje i započnite <strong>novu trasu</strong>.</li>
                <li>Dodajte čvorove trase te završite alatnom trakom ili dvostrukim klikom.</li>
                <li>Kliknite blizu trase za <strong>postavljanje stanice</strong>; povlačenjem je pomičete po trasi.</li>
                <li>Odaberite trasu za pomicanje čvorova, promjenu razina i pregled visinskog profila.</li>
                <li>Na remizi izradite <strong>liniju</strong> i odaberite stanice koje poslužuje.</li>
                <li>Dodajte vozila kroz prozor linije kako biste pokrenuli simulaciju.</li>
            </ol>
        </section>
        <section>
            <h4>Teren i građevinski objekti</h4>
            <p>Karta je 2D radna površina oslonjena na 3D teren i podatke o visinskom vođenju. Uređivač profila prikazuje stacionažu, visinu terena, projektirani nagib, tunele, usjeke, nasipe i vijadukte.</p>
            <p>Kvaliteta terena ovisi o pružatelju odabranog grada. Rezultati globalnog DEM-a preliminarni su; lokalni LiDAR ili DTM mogu dati detaljnije rezultate gdje su dostupni.</p>
        </section>
        <section>
            <h4>Simulacija i 3D</h4>
            <p>Promet počinje automatski kada linija ima vozila. Potražnja ovisi o dobu dana te broju stanovnika i radnih mjesta u dosegu stanica.</p>
            <ul>
                <li><strong>Protok vremena</strong> zaustavlja ili nastavlja vozila i potražnju.</li>
                <li><strong>Brojke nad stanicama</strong> uspoređuju ponuđeni kapacitet s putnicima koji čekaju.</li>
                <li><strong>3D prikaz</strong> otvara istu projektiranu mrežu u Station3D-u za šetnju, vožnju i pregled infrastrukture.</li>
            </ul>
        </section>
        <section>
            <h4>Podaci i dostupnost</h4>
            <p>Manifest grada određuje pružatelje usmjeravanja, terena, potražnje, referentnog prijevoza, spremanja i 3D prikaza. Kontrole su skrivene kada odabrana instalacija nema potrebne podatke ili uslugu.</p>
            <ul>
                <li><a href="https://www.openstreetmap.org/" target="_blank" rel="noopener"><strong>OpenStreetMap</strong></a> pruža osnovnu kartu i otvorene geografske podatke.</li>
                <li><a href="https://github.com/valhalla/valhalla" target="_blank" rel="noopener"><strong>Valhalla</strong></a> može računati pješačke dosege.</li>
                <li><a href="https://leafletjs.com/" target="_blank" rel="noopener"><strong>Leaflet</strong></a> pokreće uređivač karte.</li>
                <li><a href="https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM" target="_blank" rel="noopener"><strong>Copernicus DEM</strong></a> pruža zadanu globalnu terensku podlogu.</li>
            </ul>
        </section>
        <section>
            <h4>Spremanje i dijeljenje</h4>
            <p>Kada je spremanje dostupno, spremite prijedlog, usporedite ga na ljestvici i podijelite izravnu poveznicu ili snimku zaslona.</p>
        </section>`;

    const ENGLISH_LEADERBOARD_NOTE = `Click a column heading to sort; click it again to reverse the order.
        Lower cost metrics rank better, while popularity is the difference between positive and negative votes.
        Click a row to open the project on the map. Download ZIP exports tracks and stations as 3D GeoJSON,
        with service lines and connections as JSON.`;

    function normalizeLanguage(value) {
        const language = String(value || '').trim().toLowerCase().split('-')[0];
        return SUPPORTED_LANGUAGES.includes(language) ? language : null;
    }

    function detectLanguage({ search = '', stored = null, languages = [] } = {}) {
        const queryLanguage = normalizeLanguage(new URLSearchParams(String(search)).get('lang'));
        if (queryLanguage) return queryLanguage;
        const storedLanguage = normalizeLanguage(stored);
        if (storedLanguage) return storedLanguage;
        return Array.from(languages || []).some(language => normalizeLanguage(language) === 'hr') ? 'hr' : 'en';
    }

    function interpolate(template, variables = {}) {
        return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => (
            Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : match
        ));
    }

    function safeStoredLanguage() {
        try {
            return root.localStorage?.getItem(STORAGE_KEY) || null;
        } catch {
            return null;
        }
    }

    const currentLanguage = detectLanguage({
        search: root.location?.search || '',
        stored: safeStoredLanguage(),
        languages: root.navigator?.languages || [root.navigator?.language].filter(Boolean),
    });

    function t(key, variables) {
        const template = MESSAGES[currentLanguage]?.[key] || MESSAGES.en[key] || key;
        return interpolate(template, variables);
    }

    function translateText(value, language = currentLanguage) {
        if (language !== 'en') return String(value ?? '');
        const input = String(value ?? '');
        const match = input.match(/^(\s*)([\s\S]*?)(\s*)$/);
        const leading = match?.[1] || '';
        const text = match?.[2] || input;
        const trailing = match?.[3] || '';
        let translated = ENGLISH_TEXT[text];
        if (!translated) {
            translated = text
                .replace(/^← Planer$/, '← Planner')
                .replace(/^Ljestvica \((\d+)\)$/, 'Leaderboard ($1)')
                .replace(/^Trasa (\d+)/, 'Track $1')
                .replace(/^Linija (\d+)/, 'Line $1')
                .replace(/^Stanica (\d+)/, 'Station $1')
                .replace(/^Objekti — (.+)$/, 'Structures — $1')
                .replace(/^Ukupno (\d+) objek(?:t|ta|ata)$/, 'Total $1 structures')
                .replace(/^(\d+) objek(?:t|ta|ata)$/, '$1 structures')
                .replace(/^\((\d+) dionic(?:a|e)\)$/, (_, count) => `(${count} ${Number(count) === 1 ? 'segment' : 'segments'})`)
                .replace(/^(🛤️ )?Ravni teren \((\d+) dionic(?:a|e)\)$/, '$1At grade ($2 segments)')
                .replace(/^(🏘️ )?Stanica ×(\d+)$/, '$1Stations ×$2')
                .replace(/^(🏘️ )?Stanica surface$/, '$1Station · surface')
                .replace(/Uskotračna \(1000 mm\)/g, 'Metre gauge (1000 mm)')
                .replace(/\(bez uzdužnog profila — samo tunel\/teren\/vijadukt\)/g, '(no vertical profile — tunnel/surface/viaduct only)')
                .replace(/^Cijene su izvedene iz cjenika:[\s\S]*$/, 'Costs are derived from the price model: base surface-track cost × structure-type multiplier. Stations are counted in addition to the structure beneath them, so total structure length can exceed network length.')
                .replace(/^Cijenu svakog objekta možete kliknuti[\s\S]*$/, 'Click any structure cost to enter it manually — not every viaduct costs the same. Manual prices are stored only in this browser (localStorage) and are not sent to the server.')
                .replace(/^Nastavi: /, 'Continue: ')
                .replace(/^Računam doseg za (\d+) min hodanja\.\.\.$/, 'Calculating a $1-minute walking catchment…')
                .replace(/^Doseg prikazan: (\d+) min hodanja\.$/, '$1-minute walking catchment shown.')
                .replace(/^Trasa produžena: ([\d.,]+ km)$/, 'Track extended: $1')
                .replace(/^Trasa spojena skretnicom: ([\d.,]+ km)$/, 'Track connected with a switch: $1')
                .replace(/^Otvorena kabina na liniji (.+)\.$/, 'Cab opened on line $1.')
                .replace(/^Prikazano (.+) postojećih tramvajskih stanica\.$/, '$1 existing tram stops shown.')
                .replace(/^Projekt ["“](.+)["”] učitan\.$/, 'Project “$1” loaded.')
                .replace(/^Glasaj pozitivno za (.+)$/, 'Upvote $1')
                .replace(/^Glasaj negativno za (.+)$/, 'Downvote $1')
                .replace(/^Preuzmi podatke projekta (.+)$/, 'Download project data for $1')
                .replace(/^(\d+)\. mjesto$/, 'Rank $1');
        }
        return `${leading}${translated}${trailing}`;
    }

    function translateElement(element) {
        if (!element || currentLanguage !== 'en' || element.closest?.('[data-i18n-skip]')) return;
        for (const attribute of ['title', 'aria-label', 'placeholder']) {
            const value = element.getAttribute?.(attribute);
            if (!value) continue;
            const translated = ENGLISH_ATTRIBUTES[value] || translateText(value, 'en');
            if (translated !== value) element.setAttribute(attribute, translated);
        }
    }

    function translateSpecialContent(element) {
        if (!element?.matches?.('.civil-objects-disclaimer')) return;
        const text = element.textContent.trim();
        if (text.startsWith('Cijene su izvedene iz cjenika:')) {
            element.textContent = 'Costs are derived from the price model: base surface-track cost × structure-type multiplier. '
                + 'Stations are counted in addition to the structure beneath them, so total structure length can exceed network length.';
        } else if (text.startsWith('Cijenu svakog objekta možete kliknuti')) {
            element.textContent = 'Click any structure cost to enter it manually — not every viaduct costs the same. '
                + 'Manual prices are stored only in this browser (localStorage) and are not sent to the server.';
        }
    }

    function translateTree(node, documentRef) {
        if (!node || currentLanguage !== 'en') return;
        if (node.nodeType === 3) {
            if (node.parentElement?.closest('script, style, template, [data-i18n-skip]')) return;
            const translated = translateText(node.nodeValue, 'en');
            if (translated !== node.nodeValue) node.nodeValue = translated;
            return;
        }
        if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
        if (node.nodeType === 1) {
            translateSpecialContent(node);
            translateElement(node);
        }
        for (const element of node.querySelectorAll?.('.civil-objects-disclaimer') || []) {
            translateSpecialContent(element);
        }
        const walker = documentRef.createTreeWalker(node, root.NodeFilter?.SHOW_TEXT || 4);
        const textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);
        for (const textNode of textNodes) translateTree(textNode, documentRef);
        for (const element of node.querySelectorAll?.('[title], [aria-label], [placeholder]') || []) {
            translateElement(element);
        }
    }

    function withLanguage(href, language = currentLanguage, base = root.location?.href || 'http://localhost/') {
        const url = new URL(href, base);
        url.searchParams.set('lang', normalizeLanguage(language) || 'en');
        return url.href;
    }

    function decorateInternalLinks(documentRef) {
        for (const link of documentRef.querySelectorAll('a[href]')) {
            const raw = link.getAttribute('href');
            if (!raw || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
            const url = new URL(raw, root.location?.href || 'http://localhost/');
            url.searchParams.set('lang', currentLanguage);
            const next = `${url.pathname.split('/').pop() || ''}${url.search}${url.hash}`;
            if (next !== raw) link.setAttribute('href', next);
        }
    }

    function renderLanguageControls(documentRef) {
        for (const control of documentRef.querySelectorAll('[data-language]')) {
            const language = normalizeLanguage(control.dataset.language);
            const active = language === currentLanguage;
            const labels = currentLanguage === 'hr'
                ? { en: 'Koristi engleski', hr: 'Koristi hrvatski' }
                : { en: 'Use English', hr: 'Switch to Croatian' };
            control.classList.toggle('active', active);
            control.setAttribute('aria-pressed', String(active));
            control.setAttribute('aria-label', labels[language] || language);
            control.addEventListener('click', () => {
                if (!language || active) return;
                try {
                    root.localStorage?.setItem(STORAGE_KEY, language);
                } catch {
                    // The URL remains a complete, shareable override when storage is unavailable.
                }
                root.location.assign(withLanguage(root.location.href, language));
            });
        }
    }

    function applyDocument(documentRef = root.document) {
        if (!documentRef) return;
        documentRef.documentElement.lang = currentLanguage;
        const info = documentRef.querySelector('.info-modal-content');
        if (info) info.innerHTML = currentLanguage === 'hr' ? CROATIAN_INFO_HTML : ENGLISH_INFO_HTML;
        if (currentLanguage === 'en') {
            const note = documentRef.querySelector('.methodology-note');
            if (note) note.textContent = ENGLISH_LEADERBOARD_NOTE;
            const profileHint = documentRef.querySelector('.elevation-dock-settings-hint');
            if (profileHint) {
                profileHint.textContent = 'Typical values: viaduct +6 m (road clearance plus structure). '
                    + 'Tunnel −8 m allows for the tunnel envelope and cover. Shallower alignments are '
                    + 'treated as open cuttings. Hold Shift while dragging to bypass snapping.';
            }
            const objectsHint = documentRef.querySelector('.civil-objects-hint');
            if (objectsHint) {
                objectsHint.textContent = 'Click a column heading to sort, or a row to locate the structure on the map.';
            }
            const pricesNote = documentRef.querySelector('#pricesModalTitle + p');
            if (pricesNote) {
                pricesNote.textContent = 'These prices apply only in this browser. Saving recalculates the leaderboard '
                    + 'locally without changing server data.';
            }
            translateTree(documentRef.body, documentRef);
        }
        decorateInternalLinks(documentRef);
        renderLanguageControls(documentRef);
        documentRef.documentElement.classList.remove('i18n-pending');
    }

    function observe(documentRef = root.document) {
        if (!documentRef || !root.MutationObserver) return null;
        const observer = new root.MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes || []) translateTree(node, documentRef);
            }
        });
        observer.observe(documentRef.body, {
            subtree: true,
            childList: true,
        });
        return observer;
    }

    function boot(documentRef = root.document) {
        applyDocument(documentRef);
        return observe(documentRef);
    }

    return Object.freeze({
        STORAGE_KEY,
        SUPPORTED_LANGUAGES,
        currentLanguage,
        locale: currentLanguage === 'hr' ? 'hr-HR' : 'en',
        boot,
        detectLanguage,
        interpolate,
        normalizeLanguage,
        t,
        translateText,
        withLanguage,
    });
});
