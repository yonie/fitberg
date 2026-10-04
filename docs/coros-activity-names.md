# COROS activity names — implementatie

Doel: de naam die COROS voor een activiteit heeft overnemen bij elke sync, ook als de
activiteit al eerder is geïmporteerd en ook als er verder niets nieuws te importeren valt.
Een naam die de gebruiker zelf in fitberg heeft getypt is altijd leidend.

## Bewezen feiten (nagegaan op 2026-10-04, velvet)

- De COROS MCP geeft geen expliciet naamveld. `querySportRecords` antwoordt met een
  mensenleesbare lijst, één blok per activiteit:

  ```
  1. Outdoor Run — 2026-10-04
     Location: Singelloop 2026
     Start Coordinates: 52.084000, 5.110000
     Time Window: startTimestamp=1791098554 | endTimestamp=1791101540
     Duration: 49:45 | Distance: 10.13 km
     Average Pace: 4:55 /km | Avg HR: 178 bpm | Calories: 801 kcal
     LabelId: 480795696386048102 | SportType: 100
  ```

  De eerste regel is het sportlabel ("Outdoor Run", "Cycling", "Padel", "Sport(9807)").
  De `Location:`-regel is in werkelijkheid het COROS-`name`-veld: standaard
  "<plaats> <sport>" ("Utrecht Run", "Vianen Field Hockey", "Nieuwegein Padel"), en zodra
  de gebruiker de activiteit in de COROS-app hernoemt (drie puntjes → Edit → name) staat
  zijn tekst daar. Live bevestigd: de run van 2026-10-04 (LabelId 480795696386048102)
  toont `Location: Singelloop 2026`, exact de naam die de gebruiker net in COROS zette.
- `getActivityDetail` geeft alleen een coach-tekst zonder titel; `resources/list` is leeg.
- COROS FIT-bestanden bevatten de titel niet: van de 45 COROS-activiteiten in
  /home/pi/code/fitberg/data/fitberg.db hebben er 43 `name = NULL` (2 wel, uit
  `workout.wktName` van een gestructureerd workout-bestand).
- Alle 45 COROS-rijen dragen hun LabelId in `activities.source_id`.
- Van de 576 activiteiten hebben er 362 een naam (vooral uit Strava/Garmin-exports) en
  287 een `source_id`.
- `activity_edits` heeft 11 rijen, waarvan 0 met een naam — de voorrangsregel is dus nog
  niet in gebruik, maar moet meteen goed staan.
- De laatste sync: 128 activiteiten in de lijst, 83 daarvan "already in the library", dus
  die 83 zijn precies de gevallen waarin een latere rename nu verloren gaat.

## Voorrangsregel

1. `activity_edits.name` gevuld (gebruiker typte het in fitberg) → COROS komt er nooit aan.
2. De COROS-naam is veranderd sinds de vorige sync voor hetzelfde LabelId → die wint.
3. COROS-naam onveranderd en de rij heeft nog geen naam → vullen.
4. Anders: laten staan (bijvoorbeeld een naam uit een Strava-export).

Regel 2 plus 4 is het punt: een latere rename in COROS komt altijd door, zonder dat een
eerste sync een bestaande platformnaam overschrijft met COROS' standaardnaam.

De regel staat één keer, in `takeSourceName` in `server/db/edits.js`; sync en reindex
lezen hem allebei daar.

## Aanpak (zoals gebouwd)

- `server/integrations/coros-sync.js`
  - De lezer in `queryWindow` leest naast LabelId, SportType en startTimestamp ook de
    `Location:`-regel, als `name`. Ontbreekt de regel of is hij leeg, dan `null` en geen
    fout — de parser blijft defensief.
  - Stap 2b, `takeCorosNames(db, userId, activities)`, draait direct na
    `listActivities()` en vóór de fresh-filter. Daardoor draait hij ook op een sync zonder
    nieuwe activiteiten, precies het geval dat dit moest oplossen.
  - In de `finally` draait `takeCorosNames` nog een keer over `fresh`: die activiteiten
    hadden nog geen rij toen de lijst binnenkwam, en krijgen hun naam zodra ze geïmporteerd
    zijn.
  - Matching: eerst op COROS-id (`source = 'coros'`, `source_id` tot aan een eventuele
    `#`, zodat de losse benen van een multisport-bestand meedoen). Lukt dat niet, dan op
    start-seconde, zoals `knownStartSeconds` — dat vangt de activiteiten die al in de
    bibliotheek stonden voordat COROS gekoppeld was. Twee rijen op dezelfde seconde:
    geen van beide krijgt een naam.
  - `report.namesUpdated` telt mee, met een `note()` per stap, zodat de sync-log laat zien
    wat er bijgewerkt is.
- `server/db/schema.sql`: tabel `activity_names (user_id, dedupe_key, source, name,
  renamed, updated_at)`, PK (user_id, dedupe_key, source), via `CREATE TABLE IF NOT
  EXISTS`, dus de bestaande database pikt hem op zonder `ALTER`. Niet afgeleid: hij staat
  niet in `truncateDerived`, een reindex laat hem staan.
- `server/db/edits.js`:
  - `takeSourceName(db, userId, activity, source, name)` slaat op wat de bron nu zegt en
    past de voorrangsregel toe. `name` in `activity_names` is de naam van de vorige sync;
    verschilt de nieuwe daarvan, dan is het een rename (regel 2).
  - `applySourceNames(db, userId)` zet de opgeslagen namen terug na een import of reindex.
- `server/ingest/index.js`: `finishImport` roept `applySourceNames` aan vlak vóór
  `applyEdits`. Reindex loopt via `finishImport`, dus dekt dit beide. De volgorde is
  bewust: een in fitberg getypte naam heeft het laatste woord.

## Het reindex-gat

In de eerste versie vulde `applySourceNames` alleen lege namen. Dat dekte de gewone
COROS-activiteit (FIT zonder titel, na een reindex weer `NULL`, regel 3 vult hem), maar
niet een rename over een naam die het bestand zelf meegaf. Voorbeeld: een gestructureerde
workout komt binnen als "6x800m" (uit `workout.wktName`), de gebruiker hernoemt hem in
COROS naar "Baantraining", de sync neemt dat over volgens regel 2. Een reindex bouwt de
activiteit opnieuw op uit het bestand: weer "6x800m". De opgeslagen naam is niet
veranderd, dus de volgende sync ziet geen rename en laat hem staan (regel 4). De rename
was stil verdwenen.

Daarom de kolom `renamed`. `takeSourceName` zet hem op 1 op het moment dat een bronnaam
een naam vervangt die er al stond — een rename die gewonnen heeft. Een lege naam vullen
zet hem niet: na een reindex is die weer leeg en vult regel 3 hem vanzelf.

`applySourceNames` doet per rij in `activity_names`:

1. geen activiteit met die dedupe key → overslaan (telt als `missing`);
2. een getypte naam in `activity_edits` → overslaan, `applyEdits` regelt het;
3. naam al gelijk → niets te doen;
4. de activiteit heeft een naam en `renamed` is 0 → laten staan (regel 4);
5. anders → de opgeslagen naam terugzetten.

Zo overleeft een rename een rebuild: de beslissing "deze naam heeft al eens gewonnen" ligt
in de database, niet in het verschil tussen twee syncs dat een reindex uitwist.

## Niet doen

- `activity_edits` niet hergebruiken als opslag voor COROS-namen: dan is niet meer te zien
  of de gebruiker iets typte of dat COROS het zei, en vervalt regel 1.
- Niets naar COROS terugschrijven.
- Geen extra MCP-calls en geen FIT-downloads voor dit onderdeel: de lijst komt toch al
  binnen, dus geen verbruik van het dagquotum van 50.

## Tests

`npm test` (dat is `node --test test/*.test.js`). De fake-COROS in `test/coros.test.js`
emit al `Location: Fake` per record; geef de fake een echte naam per activiteit mee en dek:

- verse import neemt de naam over;
- tweede sync met een gewijzigde COROS-naam werkt bij, zonder nieuwe FIT-download;
- een naam die in fitberg getypt is blijft staan;
- een gelijkblijvende COROS-naam raakt een bestaande (Strava-)naam niet;
- de naam overleeft een reindex;
- een rename over een naam uit het FIT-bestand overleeft een reindex, een reindex zonder
  rename houdt de bestandsnaam, en een getypte naam wint ook daarna nog.

## Klaar is het als

- `npm test` groen is, ook onder Node 24;
- de wijziging zich beperkt tot: de sync, de lezer, schema/tabel, `takeSourceName` en
  `applySourceNames`, de aanroep in `finishImport`, en de tests.

## Risico's en randgevallen

- De lijst is mensenleesbare tekst van een derde partij; een verplaatst of hernoemd veld
  betekent stil geen naam meer, nooit een crash.
- Match op start-seconde is een aanname; bij twee activiteiten met dezelfde seconde
  overslaan.
- Verwijderde activiteiten in fitberg maar nog in COROS: geen rij om bij te werken, dus
  overslaan.
