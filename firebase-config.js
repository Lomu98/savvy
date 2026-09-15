// Configurazione del progetto Firebase.
//
// Questi valori NON sono segreti: identificano pubblicamente il tuo progetto
// Firebase e sono normalmente visibili nel codice sorgente di qualunque app
// web che usa Firebase. La protezione dei tuoi dati non dipende dal
// nasconderli, ma dalle regole di sicurezza di Firestore (vedi firestore.rules)
// e dal fatto che solo utenti autenticati possono leggere/scrivere.
//
// Come ottenerli:
//   1. Vai su https://console.firebase.google.com e crea (o apri) il tuo progetto.
//   2. Impostazioni progetto (icona ingranaggio) → "Le tue app" → aggiungi
//      un'app Web (</>) se non l'hai già fatto.
//   3. Copia i valori mostrati in "SDK setup and configuration" qui sotto.
//
// Vedi il README per la guida completa passo passo.

export const FIREBASE_CONFIG = {
  apiKey: "INSERISCI_LA_TUA_API_KEY",
  authDomain: "INSERISCI_IL_TUO_PROGETTO.firebaseapp.com",
  projectId: "INSERISCI_IL_TUO_PROGETTO_ID",
  storageBucket: "INSERISCI_IL_TUO_PROGETTO.appspot.com",
  messagingSenderId: "INSERISCI_IL_TUO_SENDER_ID",
  appId: "INSERISCI_IL_TUO_APP_ID"
};
