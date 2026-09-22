# Internationalization

The planner supports English (`en`) and Croatian (`hr`). English is the global
default; Croatian is selected automatically only when the browser advertises a
Croatian language preference.

Language selection order is:

1. explicit `?lang=en` or `?lang=hr` URL parameter;
2. the reader's saved language choice;
3. browser language (`hr*` selects Croatian, everything else selects English).

The application deliberately does not use IP geolocation. Browser language is
more accurate for travellers and multilingual residents, works in static
deployments, and avoids a location service and its privacy/cache implications.
The visible EN/HR switch stores the choice locally and puts it in navigational
and shared project URLs.

## Code boundary

`web/i18n.js` owns language detection, URL propagation, number/date locale and
the translation API. New dynamic UI must use `window.__transitI18n.t(key,
variables)` or a language-neutral domain value mapped at the rendering edge.
Do not branch domain logic, provider behavior or stored project data on the UI
language.

The current compatibility catalogue translates source-language strings still
present in the extracted UI and observes newly inserted DOM nodes. It is a
migration aid, not the preferred authoring model. When editing an existing
surface, move its user-facing strings to named messages rather than adding more
literal-match entries.

City manifest `locale` describes city/provider data conventions. It does not
override the reader's UI language. Currency, units, place names and imported
project names remain data and must not be translated as interface copy.
