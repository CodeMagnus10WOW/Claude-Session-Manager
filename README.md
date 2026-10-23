# Session Canvas

Eine Schaltzentrale für alle Claude-Code-Sessions auf diesem Rechner, gedacht für
viele Aufgaben gleichzeitig: Welche Session braucht dich jetzt, welche arbeitet,
welche ist fertig und wartet auf deine Prüfung.

```
node server.js
```

Dann http://localhost:4747 öffnen. Keine Installation nötig (nur Node.js).

## Cockpit

Das Cockpit ist die Standardansicht. Jede Session hat einen Zustand:

| Zustand | Bedeutung |
|---|---|
| **Braucht dich** | Claude wartet auf eine Erlaubnis, stellt eine Frage, oder sein letzter Zug endete mit einer offenen Frage an dich |
| **Hängt** | Deine letzte Nachricht blieb unbeantwortet oder der Zug wurde abgebrochen |
| **Fertig, ungelesen** | Claude ist fertig, und du hast die Antwort noch nicht angesehen |
| **Arbeitet** | Claude ist gerade dran |
| **Ruht** | nichts offen |
| **Archiviert** | von dir hier oder in der Claude-App archiviert |

**Archivieren** (auf der Kachel und in der Session) nimmt eine Session, die dich braucht, hängt
oder fertig ist, aus diesen Gruppen heraus. Sie steht dann ganz unten unter „Archiviert“ und zählt
nicht mehr mit. Tut sich in ihr etwas Neues, ist sie von selbst wieder da. „Zurückholen“ macht es
sofort rückgängig. Das Archiv des Canvas ist unabhängig vom Archiv der Claude-App.

Der Zustand kommt aus dem Verlauf (wer ist dran, wie lange ist es still), aus der
Claude-App (Zusammenfassung des letzten Zugs, „braucht Aktion“, wann du die Session
zuletzt angesehen hast) und aus dem Prozess, wenn die Session von hier gesteuert wird.

- **Links** die Liste, nach Zustand gruppiert; wer am längsten auf dich wartet, steht oben.
  Die ersten neun Einträge erreichst du mit den Tasten `1` bis `9`, `j`/`k` gehen weiter und zurück.
- **Mitte, Übersicht**: alle Sessions als Kacheln mit Zustand, Zusammenfassung, Fortschritt der
  Aufgabenliste und Sofort-Aktionen: „Erlauben“/„Ablehnen“ für wartende Erlaubnisse,
  Schnellantworten auf Claudes Frage, „Gelesen“, „Stoppen“, „In Claude öffnen“.
- **Mitte, Session**: Klick auf Kachel oder Listeneintrag öffnet die Session mit Zustand,
  Aufgabenliste (aus der Claude-App), Schnellantworten, Notiz, Verlauf und Eingabe. `Esc` führt
  zurück zur Übersicht.
- **Oben** die Zähler: Klick darauf filtert. Der Tab-Titel zeigt die Zahl der Sessions, die dich brauchen.
- **Benachrichtigen** schickt eine Desktop-Benachrichtigung, sobald eine Session dich braucht
  oder fertig ist, wenn die Seite gerade nicht im Vordergrund ist. **Ton** spielt dazu einen kurzen Klang.
- **Notiz**: pro Session ein paar Worte für dich (worum geht es, was ist der nächste Schritt).
  Sie erscheint in Liste und Kachel und wird von der Suche gefunden.

`M` wechselt zwischen Cockpit und Karte.

## Karte

Die zweite Ansicht ist die Sternkarte: Jedes Projekt ist ein Sternbild, jede Session ein Stern.
Zoomst du hinein, wird aus dem Stern eine Karte und schließlich der laufende Verlauf.

## Was du auf der Karte siehst

- **Ganze Karte**: Projekte als Sternbilder mit farbigem Nebel. Je heller ein Stern,
  desto kürzer ist die Session her, je größer, desto mehr Prompts. Die Linien verbinden
  die Sessions eines Projekts in der Reihenfolge, in der sie entstanden sind.
  Laufende Sessions senden grüne Wellen aus.
- **Näher dran**: Karten mit letztem Prompt, Aktivitätskurve über die Dauer der Session,
  Prompts, Tool-Aufrufe und Kosten bzw. erzeugte Tokens.
- **Ganz nah**: die letzten Nachrichten und Tool-Aufrufe, live.
- **Logbuch**: der komplette Verlauf mit Formatierung, Werkzeuge eingeklappt.
- **Funksprüche** oben rechts: Sobald eine Session eine neue Nachricht bekommt,
  leuchtet ihr Stern auf und sie erscheint dort. Klick fliegt hin.

## Liste und Filter

Die Liste gibt es in beiden Ansichten (auf der Karte blendet `L` sie ein und aus).
Sie lässt sich nach Status oder Projekt gruppieren oder nach „Neueste“, „Prompts“ und „Tokens“ sortieren.
Filter gibt es für Text, Status (braucht dich, arbeitet, fertig, von hier gesteuert),
Zeitraum (24 Stunden, 7 oder 30 Tage) und Herkunft (Claude-App, VS Code, Terminal).
Die Filter gelten überall: in der Übersicht, in der Liste und auf der Karte.

Auf der Karte fliegt ein Klick auf einen Eintrag hin, Doppelklick oder `Enter` öffnet die Session.

## Suche im Wortlaut

`Strg K` oder `/` sucht in Titeln und Projekten und ab drei Zeichen auch im Wortlaut
aller Verläufe. Ein Treffer öffnet das Logbuch genau an dieser Stelle und markiert das Wort.
Durchsucht werden die letzten 1500 Nachrichten jeder Session.

## Neue Session starten

„Neue Session“ (oder `N`, oder „Neue Session“ neben einem Projekt in der Liste) startet Claude
in einem deiner Projektordner oder in einem beliebigen anderen Ordner. Du schreibst die erste
Nachricht, die Session erscheint auf der Karte, und das Logbuch öffnet sich. Von dort steuerst
du sie wie unten beschrieben.

## Geänderte Dateien

Im Logbuch unter „Details“ stehen alle Dateien, die Claude in der Session geschrieben oder
bearbeitet hat, die zuletzt geänderten zuerst. Ein Klick öffnet die Datei in VS Code
(ohne VS Code: im Explorer). Geöffnet werden nur Dateien, die wirklich zu dieser Session gehören.

## Dort öffnen, wo die Session herkommt

Jede Karte und das Logbuch haben einen Öffnen-Knopf, passend zur Herkunft:

| Entstanden in | Knopf | Was passiert |
|---|---|---|
| Claude-App (Code) | „In Claude öffnen“ | Die App springt zur Session (`claude://code/continue?session=local_…`) |
| VS Code | „In VS Code öffnen“ | VS Code öffnet den Projektordner und darin die Session im Claude-Panel |
| Terminal | „Im Terminal öffnen“ | Neues Terminal im Projektordner mit `claude --resume <id>` |

Sessions, die in der Claude-App archiviert sind, findet der App-Link nicht mehr. Sie öffnen sich
deshalb im Terminal. Im Logbuch gibt es zusätzlich immer „Im Terminal öffnen“.
Arbeitet Claude in einer Session gerade vom Canvas aus, musst du sie erst stoppen oder trennen,
damit nicht zwei Programme gleichzeitig schreiben. Eine verbundene, aber ruhende Session wird
beim Öffnen automatisch getrennt.

Unter Windows wird Windows Terminal benutzt, wenn es installiert ist, sonst die normale
Eingabeaufforderung. Für VS Code muss der Befehl `code` verfügbar sein (Standard bei der Installation).

## Weiterarbeiten (Sessions steuern)

Im Logbuch jeder Session (Knopf „Weiterarbeiten“) kannst du Claude direkt schreiben.
Die erste Nachricht setzt die Session mit `claude -p --resume <id>` im Projektordner fort,
mit demselben Modell und demselben Verlauf. Danach bleibt der Prozess verbunden:

- Claudes Antwort erscheint live, während sie geschrieben wird.
- **Berechtigungen**: Will Claude einen Befehl ausführen oder eine Datei ändern, erscheint
  eine Karte mit „Erlauben“ / „Ablehnen“. Der Stern bekommt einen Messingring, und oben rechts
  meldet sich die Session, auch wenn das Logbuch zu ist. Fragen von Claude (mit Antwortoptionen)
  beantwortest du genauso.
- Die Auswahl links unten legt fest, was Claude ohne Nachfrage darf: bei allem fragen,
  Dateiänderungen erlauben oder nur planen.
- Daneben wählst du **Modell** (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5, ohne Auswahl das
  Modell der Session) und **Effort** (low bis max, ohne Auswahl der Standard). Beides gilt ab dem
  Start des Prozesses: Änderst du es, startet Claude für diese Session mit der nächsten Nachricht
  neu, mit demselben Verlauf. Während Claude arbeitet, geht der Wechsel nicht.
- **Stoppen** bricht die laufende Antwort ab, **Trennen** beendet den Prozess.
  Nach 15 Minuten ohne Aktivität trennt sich der Prozess von selbst.
- Während Claude arbeitet, kannst du eine weitere Nachricht nachschieben.

Wichtig: Ist eine Session gleichzeitig in der Claude-App oder einem Terminal geöffnet, schreiben
zwei Programme in denselben Verlauf, und er kann sich aufspalten. Die Oberfläche warnt, wenn
eine Session in den letzten Minuten woanders aktiv war. Für Sessions, die in der Claude-App
laufen, ist „Remote Control“ der App der sichere Weg, sie von woanders zu steuern.

Hat sich ein Verlauf aufgespalten (zwei Programme haben geschrieben, oder in der Claude-App wurde
zurückgesprungen), steht bei der Session „Verlauf aufgespalten“. Canvas zeigt dann nur den Zweig,
der zuletzt weitergeschrieben wurde, und markiert im Logbuch die Stelle, an der sich der Verlauf
geteilt hat. Der andere Zweig bleibt in der Datei erhalten, wird aber nicht mehr angezeigt.
Parallele Tool-Aufrufe zählen nicht als Aufspaltung, auch wenn sie im Transkript verzweigt sind.

Voraussetzung: Claude Code (`claude`) ist installiert und angemeldet. Liegt es nicht im PATH:
`CLAUDE_BIN=C:\pfad\claude.exe node server.js`.

## Tasten

| Überall | |
|---|---|
| Suchen (auch im Wortlaut) | `Strg K` oder `/` |
| Neue Session | `N` |
| Cockpit / Karte wechseln | `M` |
| Schließen, zurück, Filter aufheben | `Esc` |

| Im Cockpit | |
|---|---|
| Session 1 bis 9 der Liste öffnen | `1` bis `9` |
| Nächste / vorige Session | `j` / `k` oder Pfeiltasten |
| Nachricht senden | `Enter` (Zeilenumbruch mit `Umschalt Enter`) |

| Auf der Karte | |
|---|---|
| Zoomen | Mausrad, Zwei-Finger-Geste, `+` / `−` |
| Verschieben | Ziehen (mit Schwung) |
| Zu einer Session fliegen | Klick auf Stern, Karte oder Listeneintrag |
| Session öffnen | Klick auf eine nahe Karte, „Weiterarbeiten“, `Enter` |
| Liste ein/aus | `L` |
| Nachbar-Session | Pfeiltasten |
| Rundflug | Leertaste |
| Ganze Karte | `0` |

Die runde Übersichtskarte unten rechts kannst du anklicken oder ziehen.

## Optionen

- `PORT=5000 node server.js`: anderer Port
- `CLAUDE_PROJECTS=D:\pfad node server.js`: anderer Ordner (Standard: `~/.claude/projects`)

Der Server ist nur lokal (127.0.0.1) erreichbar und lehnt Anfragen mit fremdem Host ab.
Steuerbefehle brauchen zusätzlich ein Token, das bei jedem Start neu erzeugt und nur in die
eigene Seite eingesetzt wird. Andere Webseiten in deinem Browser können also keine Sessions steuern.
Neue Nachrichten kommen per Dateiüberwachung sofort an; wachsende Dateien werden
nur ab der letzten Stelle weitergelesen.
