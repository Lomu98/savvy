# Spese

App personale per tracciare spese, impostare budget mensili per categoria, gestire spese ricorrenti e vedere l'andamento nel tempo. È una PWA installabile sul telefono, con i dati sincronizzati in tempo reale su tutti i tuoi dispositivi tramite Firebase.

Nessun framework, nessuna build: HTML, CSS e JavaScript puri (ES modules). Il backend è Firebase (Authentication con Google Sign-In + Firestore come database).

## Struttura del progetto

```
spese-tracker/
├── index.html              markup della pagina
├── styles.css               tutti gli stili
├── app.js                   logica dell'app (stato, viste, grafici, Firebase)
├── firebase-config.js       le chiavi del TUO progetto Firebase (da compilare)
├── manifest.json            manifest PWA (icona, nome, colori)
├── sw.js                    service worker (cache dell'app shell per l'uso offline)
├── firestore.rules          regole di sicurezza del database (solo il proprietario legge/scrive i propri dati)
├── icon-192.png / icon-512.png / icon-512-maskable.png / apple-touch-icon.png
├── package.json             solo per uno script di sviluppo locale (nessuna dipendenza)
├── vercel.json               header di cache per Vercel
└── .gitignore
```

## 1. Creare il progetto Firebase

1. Vai su [console.firebase.google.com](https://console.firebase.google.com) e accedi con il tuo account Google.
2. **Crea un progetto** (es. "spese-tracker"). Puoi disattivare Google Analytics, non serve.
3. Nella pagina del progetto, clicca l'icona **`</>`** ("Aggiungi app" → Web) per registrare una app web. Non serve Firebase Hosting: basta registrare l'app.
4. Copia i valori mostrati in `firebaseConfig` (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId) e incollali in **`firebase-config.js`**, sostituendo i placeholder.
5. Nel menu laterale vai su **Authentication** → scheda **Sign-in method** → abilita **Google** come provider → salva.
6. Sempre nel menu laterale vai su **Firestore Database** → **Crea database** → scegli una regione (una vicina, es. `eu-west` per l'Europa) → puoi partire in modalità di produzione, tanto il passo successivo imposta le regole corrette.
7. Nella scheda **Regole** di Firestore, incolla il contenuto del file `firestore.rules` di questo progetto e clicca **Pubblica**. Questo garantisce che solo tu (autenticato con il tuo Google account) possa leggere o scrivere i tuoi dati — nessun altro, anche conoscendo l'URL dell'app, può vedere le tue spese.

A questo punto il backend è pronto e gratuito (il piano Spark di Firebase copre ampiamente un utilizzo personale).

## 2. Provare l'app in locale

I moduli ES (`import`/`export` usati in `app.js`) richiedono che la pagina sia servita via `http://`, non aperta come file (`file://`) — altrimenti il browser blocca gli import per motivi di sicurezza. Serve quindi un piccolo server locale:

```bash
cd spese-tracker
npm run dev
```

Questo avvia un server statico su `http://localhost:3000` (usa `npx serve`, non richiede installazioni). Apri quell'indirizzo nel browser, accedi con Google e inizia ad aggiungere spese.

Se non hai Node.js installato: puoi scaricarlo da [nodejs.org](https://nodejs.org) (versione LTS), oppure usare in alternativa `python3 -m http.server 3000`.

## 3. Creare la repository su GitHub

Il progetto è già inizializzato come repository Git locale (con un primo commit). Per pubblicarlo su GitHub:

```bash
cd spese-tracker

# Se non l'hai già fatto, crea la repo vuota su GitHub da https://github.com/new
# (NON aggiungere README/licenza/.gitignore lì: esistono già qui)

git remote add origin https://github.com/<tuo-utente>/spese-tracker.git
git branch -M main
git push -u origin main
```

In alternativa, se hai la GitHub CLI (`gh`) installata e autenticata:

```bash
cd spese-tracker
gh repo create spese-tracker --private --source=. --remote=origin --push
```

## 4. Deploy su Vercel

**Opzione A — dashboard (più semplice):**

1. Vai su [vercel.com](https://vercel.com), accedi (puoi usare il tuo account GitHub).
2. **Add New → Project** → seleziona la repo `spese-tracker` che hai appena creato.
3. Framework Preset: lascialo su **Other** (è un sito statico, non serve alcuna build command né output directory diversa dalla root).
4. Clicca **Deploy**.

**Opzione B — CLI:**

```bash
npm i -g vercel
cd spese-tracker
vercel        # segue un wizard interattivo, poi:
vercel --prod
```

Al termine otterrai un URL tipo `https://spese-tracker.vercel.app`, servito in HTTPS — condizione necessaria perché il service worker e l'installazione come PWA funzionino.

### Un passaggio importante dopo il primo deploy

Firebase Authentication accetta login solo da **domini autorizzati**. Il dominio Vercel che ti viene assegnato non è autorizzato di default:

1. Copia il dominio del deploy (es. `spese-tracker.vercel.app`, oppure il tuo dominio personalizzato se ne colleghi uno).
2. Firebase Console → **Authentication** → **Settings** → **Authorized domains** → **Add domain** → incolla il dominio.
3. Ricarica la pagina: ora "Accedi con Google" funzionerà anche in produzione.

(`localhost` è già autorizzato di default, per questo il test in locale al punto 2 funziona senza bisogno di questo passaggio.)

## 5. Installare l'app sul telefono

Apri l'URL Vercel dal browser del telefono:

- **iPhone (Safari):** tocca l'icona di condivisione → "Aggiungi alla schermata Home".
- **Android (Chrome):** menu ⋮ → "Installa app" (o "Aggiungi a schermata Home").

Da questo momento l'icona sulla home apre l'app in una finestra a schermo intero, senza barra del browser. Il service worker mette in cache l'interfaccia per un avvio rapido anche offline; le scritture fatte offline vengono messe in coda da Firestore e sincronizzate automaticamente al ritorno della connessione.

## Note su sicurezza e costi

- Le chiavi in `firebase-config.js` **non sono segrete**: identificano pubblicamente il progetto Firebase, non danno accesso ai dati. La protezione reale sono le regole in `firestore.rules` (solo `request.auth.uid` autenticato può leggere/scrivere il proprio percorso `users/{uid}/...`) — verifica sempre di averle pubblicate prima di considerare i dati al sicuro.
- Il piano gratuito di Firebase (Spark) e quello di Vercel (Hobby) coprono comodamente un uso personale come questo; non dovresti incontrare costi a meno di un utilizzo molto più intenso o di funzionalità aggiuntive.
- Se in futuro vuoi condividere l'app con altre persone (es. un partner), la struttura dati è già pronta: ogni utente Google che accede ottiene automaticamente il proprio spazio isolato sotto `users/{suo-uid}/...`, senza modifiche al codice.

## Personalizzazione

- **Categorie**: modifica l'array `CATEGORIES` in `app.js` (badge colore, nome, slug). I colori sono variabili CSS definite in `styles.css` (`--cat-*`), coordinate tra chiaro e scuro.
- **Soglie di avviso budget**: funzione `statusForPct` in `app.js` (attualmente: verde sotto l'80%, giallo all'80–99%, rosso dal 100%).
- **Tema**: la app segue automaticamente il tema chiaro/scuro del sistema operativo (`prefers-color-scheme`).
