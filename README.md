# Fredy MCP Bridge

Ein Sidecar-Container für [Fredy](https://github.com/orangecoding/fredy), der Fredys MCP-Server um
fehlende Funktionen ergänzt – ohne Fredy selbst zu verändern. Fredy bleibt ein ganz normales
Image und kann wie gewohnt aktualisiert werden.

> Inoffizielle Ergänzung, nicht Teil des Fredy-Projekts. Alle Anerkennung für Fredy gebührt
> Christian Kellner und den Fredy-Mitwirkenden. Details siehe [LICENSE.txt](LICENSE.txt).

## Was die Bridge macht

```
MCP-Client (Claude.ai, ChatGPT, …)
        │  https://fredy-mcp.example.de/mcp   (OAuth)
        ▼
 Fredy MCP Bridge ──► Fredys eigener MCP-Server  /api/mcp      (alle Fredy-Tools, 1:1 durchgereicht)
                  └─► Fredys REST-API             /api/listings… (Zusatz-Tools, als der jeweilige Benutzer)
```

- **Durchreichen:** Alle Tools von Fredys MCP erscheinen unverändert – auch solche, die Fredy künftig
  neu mitbringt.
- **Ergänzen:** Inserate löschen (ausblenden) und wiederherstellen, endgültig löschen,
  Bewerbungsstatus, Betrugsmarkierung, Suchjob starten, Suchjob aktivieren/pausieren,
  Finanzprofil (Fredys Finanzierung) ansehen und gezielt ändern, Inseratsdetails beim Portal
  nachladen (wie „Aktualisieren“ bei der Beschreibung; gebremst auf einen Abruf gleichzeitig und
  `DETAILS_REFRESH_PER_HOUR` pro Stunde, Standard 20).
- **Preisverlauf** eines Inserats abrufen (inkl. Veränderung seit dem Fund).
- **Orte für Fahrzeiten** ansehen, hinzufügen, ändern, umbenennen und entfernen – feste Adressen
  (Arbeit, eine bestimmte Schule) oder Ortstypen wie „nächste Schule“, die Fredy pro Inserat sucht;
  jeweils mit Verkehrsmittel und Abfahrtszeit. Dazu **exakte Fahrzeiten** für einzelne Inserate
  (gebremst über `TRAVEL_TIMES_PER_HOUR`, Standard 30).
- **Bewerberprofil und Anschreiben-Vorlagen** ansehen und ändern; Vorlagen-Entwürfe lassen sich mit
  dem echten Profil in der Vorschau prüfen, Tippfehler in Platzhaltern werden gemeldet.
- **OAuth für Remote-Connectoren** mit eigener Login-Seite – angemeldet wird mit dem **Fredy-Konto**.
- **Zugangs-Tokens für Clients ohne OAuth** (OpenClaw, n8n, Skripte): auf der Übersicht erzeugen,
  mit Rechten und Gültigkeit (30/90/365 Tage oder ohne Ablauf). Ein Token ist eine normale Verbindung
  – umbenennen, Rechte ändern, trennen. Senden als `Authorization: Bearer fmb_…` an `/mcp`.
- **Fredys eigene Hinweise** für Sprachmodelle werden zusammen mit denen der Bridge an den Client
  weitergereicht.
- **Rechte pro Verbindung:** Was Fredy anbietet, ist standardmäßig an; alle Zusätze sind Opt-in.
  Einzelne Fredy-Tools lassen sich pro Verbindung sperren. Verbindungen jederzeit trennbar.
- **Rollen-Obergrenzen:** Admins legen fest, was Fredy-Admins bzw. normale Benutzer überhaupt
  freigeben dürfen.
- **Sprachen wie Fredy:** Englisch (Standard), Deutsch, Spanisch, Französisch, Italienisch. Nach dem
  Login folgt die Oberfläche der Sprache im Fredy-Profil; Änderungen dort greifen innerhalb einer
  Minute. Ohne gewählte Sprache – oder bei einer Sprache, die die Bridge nicht kennt – Englisch.
- **Fredy entscheidet über Sichtbarkeit:** Jeder Aufruf läuft über Fredys Reverse-Proxy-Anmeldung als
  genau der verbundene Benutzer. Eigene/geteilte Jobs, Admin-Rechte und Demo-Modus prüft Fredy selbst.

### Löschen vs. endgültig löschen

| Tool | Wirkung | Kommt beim nächsten Suchlauf wieder? |
|---|---|---|
| `hide_listings` | wie „Löschen“ in der Fredy-Oberfläche (ausblenden) | **nein** – Fredy kennt das Inserat weiter |
| `restore_listings` | holt ausgeblendete Inserate zurück | – |
| `delete_listings_permanently` | entfernt den Datensatz komplett | **ja**, wenn das Inserat noch online ist |

## Einrichtung

### 1. Stack in Portainer erweitern

Siehe [`docker-compose.example.yml`](docker-compose.example.yml). Wichtig sind das gemeinsame
Netz `fredy-net` mit fester IP für die Bridge und die Stack-Variable `FREDY_PROXY_SECRET`
(z. B. `openssl rand -hex 32`).

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `PUBLIC_URL` | ja | Öffentliche HTTPS-Adresse der Bridge, ohne Pfad |
| `FREDY_PROXY_SECRET` | ja | Gemeinsames Geheimnis, identisch in Fredy eingetragen |
| `FREDY_URL` | | Fredy im Docker-Netz, Standard `http://fredy:9998` |
| `FREDY_PROXY_USER_HEADER` | | Standard `Remote-User` |
| `FREDY_PROXY_SECRET_HEADER` | | Standard `X-Fredy-Proxy-Secret` |
| `FREDY_ADMIN_USERNAME` | | Fredy-Admin zum Abholen der MCP-Tokens; ohne Angabe der zuletzt an der Bridge angemeldete Admin |
| `TRAVEL_TIMES_PER_HOUR` | | Höchstzahl exakter Fahrzeit-Abfragen pro Benutzer und Stunde, Standard 30 |
| `DETAILS_REFRESH_PER_HOUR` | | Höchstzahl Detailseiten-Abrufe pro Benutzer und Stunde, Standard 20 |
| `TRUST_PROXY` | | Wem X-Forwarded-For geglaubt wird, Standard: private Netze |
| `TZ` | | Zeitzone für die Anzeige |

### 2. Fredy: Reverse-Proxy-Anmeldung

Fredy → *Einstellungen → System → Anmeldung durch den Reverse-Proxy*:

- **Identitäts-Header von vertrauenswürdigen Proxys akzeptieren:** an
- **Vertrauenswürdige Proxy-Adressen:** `172.31.250.10` (nur die Bridge, **kein** ganzes Netz)
- **Benutzername-Header:** `Remote-User`
- **Header für gemeinsames Geheimnis:** `X-Fredy-Proxy-Secret`
- **Gemeinsames Geheimnis:** derselbe Wert wie `FREDY_PROXY_SECRET`

Fredy prüft die TCP-Gegenstelle, nicht `X-Forwarded-For`. Zugriffe aus dem Internet oder dem LAN
kommen nie von `172.31.250.10` – und brauchen zusätzlich das Geheimnis. Der normale Fredy-Login
funktioniert unverändert weiter.

### 3. Reverse Proxy (z. B. Nginx Proxy Manager)

Proxy Host für die Subdomain der Bridge → `http://<Docker-Host-IP>:9999`, SSL-Zertifikat
(Let's Encrypt), *Force SSL*. Claude.ai verlangt HTTPS.

### 4. Erste Anmeldung

`https://<bridge>/` öffnen und **einmal als Fredy-Admin anmelden**. Unter *Zustand* sollten alle
drei Prüfungen grün sein. Danach im MCP-Client die Connector-URL `https://<bridge>/mcp` eintragen.

## Betrieb

- **Daten:** `/data/bridge.sqlite` (Verbindungen, Rechte, Tokens als Hash). Fredys Datenbank wird nie
  angefasst.
- **Selbsttest und Healthcheck:** alle 5 Minuten (nach einem Fehler nach 30 Sekunden). Schlägt eine
  Prüfung fehl – Fredy nicht erreichbar, API geändert, Proxy-Anmeldung kaputt –, meldet `/healthz`
  HTTP 503 und Docker/Portainer zeigt den Container als *unhealthy*. Ins Log schreibt die Bridge nur
  bei Änderungen (`!!! Self-test …`), Details stehen unter *Zustand*.
- **Versionen:** Unter *Zustand* (Admins) stehen Bridge-Version, Commit, Build-Datum und Fredys
  Version, jeweils mit Hinweis, wenn es Neueres gibt; die Fußzeile zeigt die Bridge-Version.
- **Wenn Fredy die Zusätze selbst mitbringt:** Ein gleichnamiges Fredy-Tool ersetzt automatisch das
  Bridge-Tool.
- **Tokens:** Access-Token 1 h, Refresh-Token 30 Tage (rotierend; ein wiederverwendeter alter
  Refresh-Token widerruft die Token-Familie).

## Sicherheit und Updates

- **Dependency-Audit** (`.github/workflows/audit.yml`): bei jedem Push und montags automatisch –
  `npm audit` für die Laufzeit-Pakete und ein Trivy-Scan des fertigen Images (Debian-Pakete, Node,
  npm-Pakete). Rot wird er bei kritischen oder hohen Lücken, für die es schon einen Fix gibt; alle
  Funde ab „mittel“ erscheinen unter *Security → Code scanning*.
- **Dependabot** (`.github/dependabot.yml`) schlägt Updates für npm-Pakete, das Docker-Basis-Image und
  die GitHub Actions als Pull Request vor.
- **Wöchentlicher Neubau** (sonntags): Das Image spielt beim Bau die Debian-Sicherheitsupdates ein,
  `:latest` ist also höchstens eine Woche alt. In Portainer per „Re-pull image“ übernehmen.

## Entwicklung

```bash
npm install
npm test
PUBLIC_URL=http://localhost:3000 FREDY_URL=http://127.0.0.1:9998 FREDY_PROXY_SECRET=… DATA_DIR=./data npm start
npm run licenses   # LICENSE.txt nach Paket-Updates neu erzeugen
```

Übersetzungen liegen in `src/locales/<sprache>.json`; `en.json` ist die Referenz. Der Test
`test/i18n.test.js` prüft, dass jede Sprache alle Schlüssel und dieselben Platzhalter hat.
