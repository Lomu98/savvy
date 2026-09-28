// Savvy — app di tracciamento spese personali.
// Backend: Firebase Authentication (Google Sign-In) + Firestore.
// Ogni utente autenticato legge/scrive solo sotto users/{uid}/... —
// vedi firestore.rules per l'applicazione lato server di questa regola.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, writeBatch,
  onSnapshot, query, where, orderBy
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

(function () {
  "use strict";

  /* ============================= VIEWPORT ACCORCIATO (iOS 26, app installata) ============================= */
  // Nell'app installata iOS 26 accorcia il viewport dell'altezza della barra
  // di stato senza spostarlo: resta una striscia in fondo che iOS non fa
  // disegnare alla pagina (vedi styles.css, --viewport-gap). Lo scarto si
  // misura solo in verticale (screen è sempre riferito al portrait su iOS)
  // e solo a tastiera chiusa, cioè quando il viewport non è più basso dello
  // schermo meno la barra di stato più alta possibile (~60px).
  var isStandalone = !!navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  function updateViewportGap() {
    var gap = 0;
    var portrait = Math.abs(window.innerWidth - screen.width) < 2;
    var missing = screen.height - window.innerHeight;
    if (isStandalone && portrait && missing > 0 && missing <= 64) gap = missing;
    document.documentElement.style.setProperty("--viewport-gap", gap + "px");
  }
  updateViewportGap();
  window.addEventListener("resize", updateViewportGap);
  window.addEventListener("pageshow", updateViewportGap);

  /* ============================= DATA ============================= */
  var DEFAULT_EXPENSE_CATEGORIES = [
    { slug: "alimentari",  name: "Alimentari",      color: "var(--cat-alimentari)" },
    { slug: "trasporti",   name: "Trasporti",       color: "var(--cat-trasporti)" },
    { slug: "casa",        name: "Casa e bollette", color: "var(--cat-casa)" },
    { slug: "svago",       name: "Svago",           color: "var(--cat-svago)" },
    { slug: "salute",      name: "Salute",          color: "var(--cat-salute)" },
    { slug: "shopping",    name: "Shopping",        color: "var(--cat-shopping)" },
    { slug: "abbonamenti", name: "Abbonamenti",     color: "var(--cat-abbonamenti)" },
    { slug: "altro",       name: "Altro",           color: "var(--cat-altro)" }
  ];
  var DEFAULT_INCOME_CATEGORIES = [
    { slug: "stipendio",     name: "Stipendio",     color: "var(--inc-stipendio)" },
    { slug: "freelance",     name: "Freelance",     color: "var(--inc-freelance)" },
    { slug: "regali",        name: "Regali",        color: "var(--inc-regali)" },
    { slug: "rimborsi",      name: "Rimborsi",      color: "var(--inc-rimborsi)" },
    { slug: "investimenti",  name: "Investimenti",  color: "var(--inc-investimenti)" },
    { slug: "altro-entrata", name: "Altro",         color: "var(--inc-altro)" }
  ];
  function allCategories(){ return DEFAULT_EXPENSE_CATEGORIES.concat(DEFAULT_INCOME_CATEGORIES).concat(state.customCategories); }
  function getCategories(kind){
    kind = kind || "expense";
    var defaults = kind === "income" ? DEFAULT_INCOME_CATEGORIES : DEFAULT_EXPENSE_CATEGORIES;
    var custom = state.customCategories.filter(function(c){ return (c.kind || "expense") === kind; });
    return defaults.concat(custom);
  }
  function catByslug(slug){ return allCategories().find(function(c){ return c.slug === slug; }) || DEFAULT_EXPENSE_CATEGORIES[DEFAULT_EXPENSE_CATEGORIES.length-1]; }
  function catInitial(slug){ return catByslug(slug).name.charAt(0).toUpperCase(); }
  function slugify(s){
    return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "categoria";
  }
  function uniqueCategorySlug(name){
    var base = slugify(name), slug = base, n = 2;
    var existing = allCategories();
    while (existing.some(function(c){ return c.slug === slug; })) { slug = base + "-" + n; n++; }
    return slug;
  }

  /* ============================= STATE ============================= */
  var state = {
    expenses: [],
    incomes: [],
    budgets: {},
    recurring: [],
    customCategories: [],
    currentMonth: monthKeyFromDate(new Date()),
    currentView: "home",
    listType: "expense",
    listFilter: "all"
  };
  var toastTimer = null;

  // Date sempre nel fuso locale: toISOString() restituirebbe la data UTC,
  // che in Italia tra mezzanotte e l'1/2 di notte è ancora "ieri".
  function isoFromDate(d){ return d.getFullYear() + "-" + pad2(d.getMonth()+1) + "-" + pad2(d.getDate()); }
  function todayISO(){ return isoFromDate(new Date()); }
  function monthKeyFromDate(d){ return isoFromDate(d).slice(0,7); }
  function pad2(n){ return String(n).padStart(2,"0"); }
  function daysInMonth(year, month){ return new Date(year, month, 0).getDate(); } // month: 1-12
  function addMonths(ym, delta){
    var parts = ym.split("-"); var y = parseInt(parts[0],10); var m = parseInt(parts[1],10);
    var d = new Date(y, m - 1 + delta, 1);
    return d.getFullYear() + "-" + pad2(d.getMonth()+1);
  }
  function formatMoney(n){
    n = Number(n) || 0;
    return n.toLocaleString("it-IT", { style: "currency", currency: "EUR" });
  }
  function formatMonthLabel(ym){
    var parts = ym.split("-");
    var d = new Date(parseInt(parts[0],10), parseInt(parts[1],10) - 1, 1);
    return d.toLocaleDateString("it-IT", { month: "long", year: "numeric" });
  }
  function formatDayHeading(iso){
    var d = new Date(iso + "T00:00:00");
    var s = d.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  // L'anno compare solo se diverso da quello corrente (utile per le
  // scadenze annuali e per lo storico).
  function formatShortDate(iso){
    var d = new Date(iso + "T00:00:00");
    var opts = { day: "numeric", month: "short" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("it-IT", opts);
  }
  // Classe colore per un saldo: zero resta neutro, non "positivo".
  function signClass(n){ return n < 0 ? "negative" : n > 0 ? "positive" : ""; }

  function expensesForMonth(ym){
    return state.expenses.filter(function(e){ return typeof e.date === "string" && e.date.slice(0,7) === ym; });
  }
  function incomesForMonth(ym){
    return state.incomes.filter(function(e){ return typeof e.date === "string" && e.date.slice(0,7) === ym; });
  }
  function totalOf(list){ return list.reduce(function(s,e){ return s + (Number(e.amount) || 0); }, 0); }
  function sumByCategory(list){
    var map = {};
    list.forEach(function(e){ map[e.category] = (map[e.category] || 0) + (Number(e.amount) || 0); });
    return map;
  }
  function statusForPct(pct){
    if (pct >= 1) return "critical";
    if (pct >= 0.8) return "warning";
    return "good";
  }
  function statusIcon(status){
    if (status === "critical") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>';
    if (status === "warning") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16h.01"/><circle cx="12" cy="12" r="9"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9 17l11-11"/></svg>';
  }
  function statusLabel(status){
    if (status === "critical") return "Oltre budget";
    if (status === "warning") return "Vicino al limite";
    return "Sotto controllo";
  }
  // Sicuro sia nel testo sia dentro attributi tra virgolette.
  var HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return HTML_ESCAPES[c]; });
  }
  // I colori finiscono dentro style="…": si accettano solo hex o var(--token).
  function safeColor(c){
    return /^#[0-9a-f]{3,8}$/i.test(c) || /^var\(--[a-z0-9-]+\)$/.test(c) ? c : "var(--cat-altro)";
  }
  // Colore del testo (chiaro o scuro) con il miglior contrasto sullo sfondo
  // dato, che può essere un hex o una var(--token) del tema corrente:
  // i colori delle categorie (soprattutto quelli scelti dall'utente) possono
  // essere tanto chiari da rendere illeggibile il bianco.
  function readableTextOn(color) {
    var hex = color;
    var m = /^var\((--[a-z0-9-]+)\)$/.exec(color);
    if (m) hex = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
    var h = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(hex);
    if (!h) return "#fff";
    var s = h[1].length === 3 ? h[1].replace(/./g, "$&$&") : h[1];
    var lum = [0, 2, 4].map(function (i) {
      var c = parseInt(s.substr(i, 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    var L = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
    var vsWhite = 1.05 / (L + 0.05), vsDark = (L + 0.05) / 0.0556;
    return vsWhite >= vsDark ? "#fff" : "#111";
  }
  // Importo → testo per un campo di input, con la virgola decimale ("" se 0).
  function formatAmountInput(n){
    return n ? String(n).replace(".", ",") : "";
  }
  // Accetta sia "12,50" sia "12.50" (e "1.234,50"); NaN se non è un numero.
  function parseAmount(str){
    var s = String(str || "").replace(/[\s€]/g, "");
    if (s.indexOf(",") !== -1) s = s.replace(/\./g, "").replace(",", ".");
    if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return NaN;
    return Number(s);
  }

  /* ============================= FIREBASE ============================= */
  var firebaseApp = initializeApp(FIREBASE_CONFIG);
  var auth = getAuth(firebaseApp);
  var dbFs;
  try {
    // Enables offline persistence: writes queue locally while offline and
    // sync automatically once the connection returns. The multi-tab manager
    // keeps persistence working when the app is open in more than one tab.
    dbFs = initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (e) {
    dbFs = initializeFirestore(firebaseApp, {});
  }

  var currentUser = null;
  var unsubTransactions = [], unsubOthers = [];
  var loadedFromMonth = null;
  var syncError = "";

  function userCollection(name){ return collection(dbFs, "users", currentUser.uid, name); }
  function userDoc(name, id){ return doc(dbFs, "users", currentUser.uid, name, id); }

  onAuthStateChanged(auth, function (user) {
    document.getElementById("bootScreen").hidden = true;
    if (user) {
      currentUser = user;
      showApp(user);
      subscribeAll();
    } else {
      currentUser = null;
      unsubscribeAll();
      showAuthScreen();
    }
  });

  document.getElementById("googleSignInBtn").addEventListener("click", function () {
    var btn = this;
    btn.disabled = true;
    document.getElementById("authStatus").textContent = "Accesso in corso…";
    signInWithPopup(auth, new GoogleAuthProvider()).catch(function (err) {
      btn.disabled = false;
      document.getElementById("authStatus").textContent = describeAuthError(err);
    });
  });

  function describeAuthError(err) {
    var code = err && err.code;
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return "";
    if (code === "auth/unauthorized-domain") return "Questo dominio non è autorizzato: aggiungilo in Firebase Console → Authentication → Settings → Authorized domains.";
    return "Accesso non riuscito. Riprova.";
  }

  function showAuthScreen() {
    document.getElementById("authScreen").hidden = false;
    document.getElementById("app").hidden = true;
    document.getElementById("googleSignInBtn").disabled = false;
    document.getElementById("authStatus").textContent = "";
  }
  // Le foto profilo Google (lh3.googleusercontent.com/...) accettano un
  // suffisso dimensione/ritaglio: "=s<px>-c" forza un crop quadrato pieno
  // sul contenuto, invece del semplice ridimensionamento (che per foto non
  // quadrate lascia margini vuoti attorno all'immagine).
  function googleCropUrl(url, size) {
    return url.replace(/=s\d+(-c)?$/, "") + "=s" + size + "-c";
  }
  function showApp(user) {
    document.getElementById("authScreen").hidden = true;
    document.getElementById("app").hidden = false;
    var btn = document.getElementById("accountBtn");
    btn.textContent = "";
    if (user.photoURL) {
      var img = document.createElement("img");
      img.src = googleCropUrl(user.photoURL, 96);
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      btn.appendChild(img);
    } else {
      btn.textContent = (user.displayName || user.email || "?").charAt(0).toUpperCase();
    }
  }

  document.getElementById("accountBtn").addEventListener("click", openAccountSheet);
  function openAccountSheet() {
    var user = currentUser;
    if (!user) return;
    var html = '<h3 style="text-align:center">Account</h3>' +
      '<p style="text-align:center;font-size:13.5px;color:var(--ink-secondary);margin-bottom:20px">' + escapeHtml(user.email || "") + '</p>' +
      '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<button type="button" class="btn-ghost" id="layoutDiagBtn">Diagnostica schermo</button>' +
      '<button type="button" class="btn-danger" id="signOutBtn">Esci</button>' +
      '</div>';
    openSheet(html);
    document.getElementById("layoutDiagBtn").addEventListener("click", openLayoutDiagnostics);
    document.getElementById("signOutBtn").addEventListener("click", function () {
      closeSheet();
      signOut(auth);
    });
  }

  /* ============================= DIAGNOSTICA LAYOUT (temporanea) ============================= */
  // Serve a capire, sul telefono vero, da dove viene la striscia sotto la
  // tabbar su iPhone: raccoglie le misure del viewport e permette di colorare
  // i livelli della pagina. Da rimuovere una volta risolto il problema.
  function measureProbe(css, read) {
    var p = document.createElement("div");
    p.style.cssText = "position:fixed;top:0;left:0;width:1px;visibility:hidden;pointer-events:none;" + css;
    document.body.appendChild(p);
    var v = read(p);
    p.remove();
    return Math.round(v * 10) / 10;
  }
  function rectOf(sel) {
    var el = document.querySelector(sel);
    if (!el) return "—";
    var r = el.getBoundingClientRect();
    return "top " + Math.round(r.top) + " · bottom " + Math.round(r.bottom) + " · h " + Math.round(r.height);
  }
  function collectLayoutInfo() {
    var vv = window.visualViewport;
    var height = function (unit) { return measureProbe("height:100" + unit, function (p) { return p.getBoundingClientRect().height; }); };
    var inset = function (side) { return measureProbe("padding-top:env(safe-area-inset-" + side + ")", function (p) { return parseFloat(getComputedStyle(p).paddingTop) || 0; }); };
    return [
      ["Standalone (navigator / display-mode)", String(!!navigator.standalone) + " / " + String(matchMedia("(display-mode: standalone)").matches)],
      ["Tema scuro", String(matchMedia("(prefers-color-scheme: dark)").matches)],
      ["screen", screen.width + " × " + screen.height],
      ["inner", window.innerWidth + " × " + window.innerHeight],
      ["outerHeight", String(window.outerHeight)],
      ["clientHeight (html)", String(document.documentElement.clientHeight)],
      ["visualViewport", vv ? Math.round(vv.height) + " (offsetTop " + Math.round(vv.offsetTop) + ", scale " + vv.scale + ")" : "n/d"],
      ["100vh / dvh / svh / lvh", [height("vh"), height("dvh"), height("svh"), height("lvh")].join(" / ")],
      ["safe-area top / bottom", inset("top") + " / " + inset("bottom")],
      ["--viewport-gap / --bottom-inset", getComputedStyle(document.documentElement).getPropertyValue("--viewport-gap").trim() + " / " +
        measureProbe("padding-top:var(--bottom-inset)", function (p) { return parseFloat(getComputedStyle(p).paddingTop) || 0; })],
      ["html", rectOf("html")],
      ["body", rectOf("body")],
      ["#app", rectOf("#app")],
      ["tabbar", rectOf("nav.tabbar")],
      ["User agent", navigator.userAgent]
    ];
  }
  function openLayoutDiagnostics() {
    var rows = collectLayoutInfo();
    var colored = document.documentElement.classList.contains("debug-layers");
    var html = '<h3>Diagnostica schermo</h3>' +
      '<p style="font-size:13px;color:var(--ink-secondary);line-height:1.5;margin-bottom:12px">' +
        'Attiva "Colora i livelli", chiudi questo pannello e guarda di che colore è la striscia sotto la barra: ' +
        '<b style="color:#ff00ff">magenta</b> = sfondo della pagina (html), <b style="color:#00b8d4">azzurro</b> = body, ' +
        '<b style="color:#e6b800">giallo</b> = contenitore dell\'app, <b style="color:#00c853">verde</b> = la barra stessa. ' +
        'Se resta <b>nera</b>, la striscia è fuori dalla pagina (la disegna iOS).</p>' +
      '<div class="card" style="padding:12px 14px;margin-bottom:12px">' + rows.map(function (r) {
        return '<div class="detail-row" style="gap:12px"><span>' + escapeHtml(r[0]) + '</span><span class="num" style="font-size:12px;word-break:break-word">' + escapeHtml(r[1]) + '</span></div>';
      }).join("") + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<button type="button" class="btn-primary" id="diagColorBtn" style="margin-top:0">' + (colored ? "Togli i colori" : "Colora i livelli") + '</button>' +
      '<button type="button" class="btn-ghost" id="diagCopyBtn">Copia i dati</button>' +
      '</div>';
    openSheet(html);
    document.getElementById("diagColorBtn").addEventListener("click", function () {
      document.documentElement.classList.toggle("debug-layers");
      closeSheet();
    });
    document.getElementById("diagCopyBtn").addEventListener("click", function () {
      var text = rows.map(function (r) { return r[0] + ": " + r[1]; }).join("\n");
      navigator.clipboard.writeText(text).then(
        function () { showToast("Dati copiati"); },
        function () { showToast("Copia non riuscita: fai uno screenshot."); }
      );
    });
  }

  /* ============================= DB LAYER (Firestore) ============================= */
  // Gli errori dei listener (es. permission-denied se le regole non sono
  // pubblicate) finiscono nel banner di stato invece di essere ignorati.
  function onSyncError(err) {
    syncError = err && err.code === "permission-denied"
      ? "Accesso ai dati negato: verifica di aver pubblicato le regole Firestore."
      : "Sincronizzazione non riuscita. I dati mostrati potrebbero non essere aggiornati.";
    updateStatusBanner();
  }
  function clearSyncError() {
    if (!syncError) return;
    syncError = "";
    updateStatusBanner();
  }

  // Si scaricano i movimenti da `loadedFromMonth` in poi (futuri inclusi).
  // Se si naviga più indietro, la finestra si allarga: niente tetto fisso
  // che faccia sparire in silenzio i mesi più vecchi.
  function subscribeTransactions(fromMonth) {
    unsubTransactions.forEach(function (u) { u(); });
    loadedFromMonth = fromMonth;
    unsubTransactions = ["expenses", "incomes"].map(function (name) {
      var q = query(userCollection(name), where("date", ">=", fromMonth + "-01"), orderBy("date", "desc"));
      return onSnapshot(q, function (snap) {
        state[name] = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        clearSyncError();
        renderCurrentView();
      }, onSyncError);
    });
  }
  // Il grafico dell'andamento mostra i 6 mesi fino a quello visualizzato.
  function ensureLoadedFrom(month) {
    var needed = addMonths(month, -5);
    if (currentUser && loadedFromMonth && needed < loadedFromMonth) subscribeTransactions(needed);
  }

  function subscribeAll() {
    unsubscribeAll();
    subscribeTransactions(addMonths(state.currentMonth, -11));

    unsubOthers.push(onSnapshot(userCollection("budgets"), function (snap) {
      var map = {};
      snap.docs.forEach(function (d) { var data = d.data(); map[d.id] = Number(data.limit) || 0; });
      state.budgets = map;
      renderCurrentView();
    }, onSyncError));

    unsubOthers.push(onSnapshot(userCollection("recurring"), function (snap) {
      state.recurring = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      renderCurrentView();
    }, onSyncError));

    unsubOthers.push(onSnapshot(userCollection("categories"), function (snap) {
      state.customCategories = snap.docs.map(function (d) {
        var data = d.data();
        return { slug: d.id, name: String(data.name || "Categoria"), color: safeColor(data.color), kind: data.kind || "expense", custom: true };
      });
      renderCurrentView();
    }, onSyncError));
  }
  function unsubscribeAll() {
    unsubTransactions.concat(unsubOthers).forEach(function (u) { u(); });
    unsubTransactions = [];
    unsubOthers = [];
    loadedFromMonth = null;
    syncError = "";
    updateStatusBanner();
    state.expenses = []; state.incomes = []; state.budgets = {}; state.recurring = []; state.customCategories = [];
  }

  function dbAddExpense(data) {
    return addDoc(userCollection("expenses"), data).catch(function () { showToast("Non salvato: controlla la connessione."); });
  }
  function dbDeleteExpense(id) {
    return deleteDoc(userDoc("expenses", id)).catch(function () { showToast("Eliminazione non riuscita."); });
  }
  function dbAddIncome(data) {
    return addDoc(userCollection("incomes"), data).catch(function () { showToast("Non salvato: controlla la connessione."); });
  }
  function dbDeleteIncome(id) {
    return deleteDoc(userDoc("incomes", id)).catch(function () { showToast("Eliminazione non riuscita."); });
  }
  function dbSetBudget(slug, limitVal) {
    return setDoc(userDoc("budgets", slug), { category: slug, limit: limitVal }).catch(function () { showToast("Budget non salvato."); });
  }
  function dbAddRecurring(data) {
    return addDoc(userCollection("recurring"), data).catch(function () { showToast("Non salvato: controlla la connessione."); });
  }
  function dbUpdateRecurring(id, data) {
    return updateDoc(userDoc("recurring", id), data).catch(function () { showToast("Aggiornamento non riuscito."); });
  }
  function dbDeleteRecurring(id) {
    return deleteDoc(userDoc("recurring", id)).catch(function () { showToast("Eliminazione non riuscita."); });
  }
  function txCollectionName(kind) { return kind === "income" ? "incomes" : "expenses"; }
  // Aggiorna un movimento esistente. Se ne cambia il tipo (spesa ↔ entrata)
  // il documento va spostato nell'altra collezione: creazione della copia e
  // cancellazione dell'originale in un'unica scrittura atomica.
  function dbUpdateTransaction(tx, newKind, changes) {
    var write;
    if (tx.kind === newKind) {
      write = updateDoc(userDoc(txCollectionName(newKind), tx.id), changes);
    } else {
      var batch = writeBatch(dbFs);
      batch.set(doc(userCollection(txCollectionName(newKind))), Object.assign({}, tx.data, changes));
      batch.delete(userDoc(txCollectionName(tx.kind), tx.id));
      write = batch.commit();
    }
    return write.catch(function () { showToast("Modifica non salvata: controlla la connessione."); });
  }
  // Registra il movimento e fa avanzare la scadenza in un'unica scrittura
  // atomica: se una delle due fallisse, la ricorrente verrebbe riproposta.
  function dbApplyRecurring(kind, txData, recurringId, recurringUpdate) {
    var batch = writeBatch(dbFs);
    batch.set(doc(userCollection(kind === "income" ? "incomes" : "expenses")), txData);
    batch.update(userDoc("recurring", recurringId), recurringUpdate);
    return batch.commit().then(function () { return true; }, function () {
      showToast("Non salvato: controlla la connessione.");
      return false;
    });
  }
  function dbAddCategory(slug, name, color, kind) {
    return setDoc(userDoc("categories", slug), { name: name, color: color, kind: kind || "expense" }).catch(function () { showToast("Categoria non salvata."); });
  }

  /* ============================= STATUS BANNER ============================= */
  function updateStatusBanner() {
    var banner = document.getElementById("offlineBanner");
    var msg = !navigator.onLine
      ? "Sei offline: le modifiche verranno sincronizzate automaticamente quando torni online."
      : syncError;
    banner.hidden = !msg;
    banner.textContent = msg;
  }
  window.addEventListener("online", updateStatusBanner);
  window.addEventListener("offline", updateStatusBanner);

  /* ============================= TOAST / SHEET ============================= */
  function showToast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }
  var sheetOverlay = document.getElementById("sheetOverlay");
  var sheetEl = document.getElementById("sheet");
  var sheetContent = document.getElementById("sheetContent");
  var sheetReturnFocus = null;

  // Il focus va al contenitore, non al primo campo: su iOS aprire la
  // tastiera in automatico sposterebbe il layout sotto il dito.
  function openSheet(html) {
    if (sheetOverlay.hidden) sheetReturnFocus = document.activeElement;
    sheetContent.innerHTML = html;
    var title = sheetContent.querySelector("h3");
    if (title) {
      title.id = "sheetTitle";
      sheetEl.setAttribute("aria-labelledby", "sheetTitle");
    } else {
      sheetEl.removeAttribute("aria-labelledby");
    }
    sheetEl.style.transform = "";
    sheetOverlay.hidden = false;
    document.documentElement.classList.add("sheet-open");
    sheetEl.focus({ preventScroll: true });
  }
  function closeSheet() {
    sheetOverlay.hidden = true;
    document.documentElement.classList.remove("sheet-open");
    sheetContent.innerHTML = "";
    if (sheetReturnFocus && document.body.contains(sheetReturnFocus)) sheetReturnFocus.focus({ preventScroll: true });
    sheetReturnFocus = null;
  }
  sheetOverlay.addEventListener("click", function (e) {
    if (e.target === sheetOverlay) closeSheet();
  });

  // Esc chiude; Tab resta all'interno del foglio finché è aperto.
  document.addEventListener("keydown", function (e) {
    if (sheetOverlay.hidden) return;
    if (e.key === "Escape") { closeSheet(); return; }
    if (e.key !== "Tab") return;
    var focusables = Array.prototype.filter.call(
      sheetEl.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])"),
      function (n) { return n.offsetParent !== null; }
    );
    if (!focusables.length) { e.preventDefault(); return; }
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sheetEl)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  });

  // Trascinando la maniglia verso il basso oltre una soglia il foglio si chiude.
  (function () {
    var handle = document.getElementById("sheetHandle");
    var startY = null, dy = 0;
    handle.addEventListener("pointerdown", function (e) {
      startY = e.clientY; dy = 0;
      handle.setPointerCapture(e.pointerId);
      sheetEl.classList.add("dragging");
    });
    handle.addEventListener("pointermove", function (e) {
      if (startY === null) return;
      dy = Math.max(0, e.clientY - startY);
      sheetEl.style.transform = "translateY(" + dy + "px)";
    });
    function endDrag() {
      if (startY === null) return;
      startY = null;
      sheetEl.classList.remove("dragging");
      if (dy > 80) closeSheet(); else sheetEl.style.transform = "";
    }
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  })();

  // Pulsante di eliminazione a due tocchi: il primo arma, il secondo
  // conferma; se non si conferma entro 3 secondi torna allo stato iniziale.
  function wireConfirmButton(btn, onConfirm) {
    var original = btn.textContent, timer = null;
    btn.addEventListener("click", function () {
      if (btn.dataset.armed === "1") { clearTimeout(timer); onConfirm(); return; }
      btn.dataset.armed = "1";
      btn.textContent = "Tocca di nuovo per confermare";
      timer = setTimeout(function () { btn.dataset.armed = ""; btn.textContent = original; }, 3000);
    });
  }

  /* ============================= NAVIGATION ============================= */
  function setView(view) {
    state.currentView = view;
    document.querySelectorAll(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-" + view); });
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      var active = b.dataset.view === view;
      b.classList.toggle("active", active);
      if (active) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    document.getElementById("views").scrollTop = 0;
    renderCurrentView();
  }
  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { setView(btn.dataset.view); });
  });
  document.getElementById("fabAdd").addEventListener("click", function () {
    if (state.currentView === "recurring") { openAddRecurringSheet("expense"); return; }
    var kind = (state.currentView === "list" && state.listType === "income") ? "income" : "expense";
    openAddTransactionSheet(kind);
  });

  function goToMonth(ym) {
    state.currentMonth = ym;
    ensureLoadedFrom(ym);
    updateMonthLabel(); renderCurrentView();
  }
  document.getElementById("prevMonthBtn").addEventListener("click", function () { goToMonth(addMonths(state.currentMonth, -1)); });
  document.getElementById("nextMonthBtn").addEventListener("click", function () { goToMonth(addMonths(state.currentMonth, 1)); });
  document.getElementById("goToTodayBtn").addEventListener("click", function () { goToMonth(monthKeyFromDate(new Date())); });
  function updateMonthLabel() {
    document.getElementById("monthLabel").textContent = formatMonthLabel(state.currentMonth);
    document.getElementById("goToTodayBtn").hidden = (state.currentMonth === monthKeyFromDate(new Date()));
  }

  function renderCurrentView() {
    if (state.currentView === "home") renderHome();
    else if (state.currentView === "list") renderList();
    else if (state.currentView === "stats") renderStats();
    else if (state.currentView === "budget") renderBudget();
    else if (state.currentView === "recurring") renderRecurring();
  }

  /* ============================= CATEGORY PICKER (shared) ============================= */
  var CATEGORY_COLOR_PALETTE = ["#b76e3d","#5a6b78","#8a5a3f","#3f8f5f","#8f4a5a","#6b7a4f","#4a4a63","#6f6b63","#4f8f8a","#b78a3f"];
  function randomCategoryColor(){ return CATEGORY_COLOR_PALETTE[Math.floor(Math.random() * CATEGORY_COLOR_PALETTE.length)]; }

  function categoryGridHtml(selectedSlug, name, kind) {
    var grid = '<div class="cat-grid" id="' + name + '" role="group" aria-label="Categoria">' + getCategories(kind).map(function (c) {
      var selected = c.slug === selectedSlug;
      return '<button type="button" class="cat-opt' + (selected ? " selected" : "") + '" aria-pressed="' + selected + '" data-slug="' + escapeHtml(c.slug) + '">' +
        '<span class="cat-dot" style="background:' + safeColor(c.color) + '"></span><span>' + escapeHtml(c.name) + '</span></button>';
    }).join("") +
      '<button type="button" class="cat-opt cat-opt-add" data-slug="__add__"><span class="cat-dot-add" aria-hidden="true">+</span><span>Nuova</span></button>' +
      '</div>';
    var form = '<div class="new-cat-form" id="' + name + 'NewCat" hidden>' +
      '<div class="new-cat-form-row">' +
        '<input type="text" class="new-cat-name" placeholder="Nome categoria" maxlength="30" aria-label="Nome nuova categoria" enterkeyhint="done">' +
        '<input type="color" class="new-cat-color" value="' + randomCategoryColor() + '" aria-label="Colore categoria">' +
      '</div>' +
      '<div class="new-cat-actions">' +
        '<button type="button" class="btn-ghost new-cat-cancel">Annulla</button>' +
        '<button type="button" class="btn-primary new-cat-save">Crea</button>' +
      '</div></div>';
    return grid + form;
  }
  function wireCategoryGrid(gridId, onSelect, kind) {
    kind = kind || "expense";
    var grid = document.getElementById(gridId);
    var form = document.getElementById(gridId + "NewCat");

    function selectOpt(opt) {
      grid.querySelectorAll(".cat-opt:not(.cat-opt-add)").forEach(function (o) {
        o.classList.remove("selected");
        o.setAttribute("aria-pressed", "false");
      });
      opt.classList.add("selected");
      opt.setAttribute("aria-pressed", "true");
      onSelect(opt.dataset.slug);
    }
    function wireOpt(opt) {
      opt.addEventListener("click", function () { selectOpt(opt); });
    }
    grid.querySelectorAll(".cat-opt[data-slug]:not(.cat-opt-add)").forEach(wireOpt);

    var addOpt = grid.querySelector(".cat-opt-add");
    addOpt.addEventListener("click", function () {
      form.hidden = false;
      form.querySelector(".new-cat-name").focus();
    });
    form.querySelector(".new-cat-cancel").addEventListener("click", function () { form.hidden = true; addOpt.focus(); });
    // Il campo sta dentro il <form> del movimento: Invio qui deve creare
    // la categoria, non inviare il movimento.
    form.querySelector(".new-cat-name").addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      form.querySelector(".new-cat-save").click();
    });
    form.querySelector(".new-cat-save").addEventListener("click", function () {
      var name = form.querySelector(".new-cat-name").value.trim();
      var color = form.querySelector(".new-cat-color").value;
      if (!name) { showToast("Inserisci un nome per la categoria."); return; }
      var slug = uniqueCategorySlug(name);
      var newCat = { slug: slug, name: name, color: color, kind: kind, custom: true };
      state.customCategories.push(newCat);
      dbAddCategory(slug, name, color, kind);

      var tile = document.createElement("button");
      tile.type = "button";
      tile.className = "cat-opt";
      tile.dataset.slug = slug;
      tile.innerHTML = '<span class="cat-dot" style="background:' + safeColor(color) + '"></span><span>' + escapeHtml(name) + '</span>';
      grid.insertBefore(tile, addOpt);
      wireOpt(tile);
      selectOpt(tile);

      form.hidden = true;
      form.querySelector(".new-cat-name").value = "";
      tile.focus({ preventScroll: true });
      showToast("Categoria creata");
    });
  }

  /* ============================= ADD TRANSACTION SHEET ============================= */
  // Ultima categoria usata per tipo, ricordata tra un avvio e l'altro.
  // localStorage può non essere disponibile (navigazione privata ecc.).
  function readLastCategory(kind) {
    try { return localStorage.getItem("savvy.lastCategory." + kind); } catch (e) { return null; }
  }
  function saveLastCategory(kind, slug) {
    try { localStorage.setItem("savvy.lastCategory." + kind, slug); } catch (e) { /* non essenziale */ }
  }
  function lastUsedCategory(kind) {
    var cats = getCategories(kind);
    var saved = readLastCategory(kind);
    return cats.some(function (c) { return c.slug === saved; }) ? saved : cats[0].slug;
  }
  // Lo stesso modulo serve per inserire e per modificare: `editing` è il
  // movimento esistente ({ id, kind, data }) oppure assente per uno nuovo.
  function openAddTransactionSheet(kind, prefill, editing) {
    kind = kind || "expense";
    var isIncome = kind === "income";
    prefill = prefill || {};
    // La categoria precompilata vale solo se esiste per il tipo scelto
    // (cambiando Spesa ↔ Entrata le categorie sono diverse).
    var initialCat = prefill.category && getCategories(kind).some(function (c) { return c.slug === prefill.category; })
      ? prefill.category
      : lastUsedCategory(kind);
    var submitLabel = editing ? "Salva modifiche" : (isIncome ? "Aggiungi entrata" : "Aggiungi spesa");
    var html =
      '<form id="txForm" novalidate>' +
      '<h3>' + (editing ? "Modifica movimento" : "Nuovo movimento") + '</h3>' +
      '<div class="type-toggle" id="txTypeToggle">' +
        '<button type="button" class="type-toggle-btn' + (!isIncome ? " active" : "") + '" aria-pressed="' + !isIncome + '" data-kind="expense">Spesa</button>' +
        '<button type="button" class="type-toggle-btn' + (isIncome ? " active" : "") + '" aria-pressed="' + isIncome + '" data-kind="income">Entrata</button>' +
      '</div>' +
      '<div class="field amount-field"><label for="txAmount">Importo</label>' +
        '<input type="text" id="txAmount" inputmode="decimal" autocomplete="off" placeholder="0,00"></div>' +
      '<div class="field"><span class="field-label">Categoria</span>' + categoryGridHtml(initialCat, "addCatGrid", kind) + '</div>' +
      '<div class="field"><label for="txDate">Data</label><input type="date" id="txDate" value="' + todayISO() + '"></div>' +
      '<div class="field"><label for="txNote">Nota (opzionale)</label><input type="text" id="txNote" placeholder="' + (isIncome ? "Es. Bonifico stipendio" : "Es. Spesa al supermercato") + '" maxlength="120" enterkeyhint="done"></div>' +
      '<button type="submit" class="btn-primary">' + submitLabel + '</button>' +
      '</form>';
    openSheet(html);
    if (prefill.amount) document.getElementById("txAmount").value = prefill.amount;
    if (prefill.date) document.getElementById("txDate").value = prefill.date;
    if (prefill.note) document.getElementById("txNote").value = prefill.note;

    var selectedCat = initialCat;
    document.querySelectorAll("#txTypeToggle .type-toggle-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.kind === kind) return;
        openAddTransactionSheet(btn.dataset.kind, {
          amount: document.getElementById("txAmount").value,
          date: document.getElementById("txDate").value,
          note: document.getElementById("txNote").value,
          category: selectedCat
        }, editing);
      });
    });

    wireCategoryGrid("addCatGrid", function (slug) { selectedCat = slug; }, kind);
    document.getElementById("txForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var amountVal = parseAmount(document.getElementById("txAmount").value);
      var dateVal = document.getElementById("txDate").value || todayISO();
      var noteVal = document.getElementById("txNote").value.trim();
      if (!amountVal || amountVal <= 0) { showToast("Inserisci un importo valido."); return; }
      if (editing) {
        dbUpdateTransaction(editing, kind, {
          amount: Math.round(amountVal * 100) / 100,
          category: selectedCat,
          date: dateVal,
          note: noteVal,
          updatedAt: new Date().toISOString()
        });
        closeSheet();
        showToast("Movimento aggiornato");
        return;
      }
      saveLastCategory(kind, selectedCat);
      var data = {
        amount: Math.round(amountVal * 100) / 100,
        category: selectedCat,
        date: dateVal,
        note: noteVal,
        recurringId: null,
        createdAt: new Date().toISOString()
      };
      if (isIncome) dbAddIncome(data); else dbAddExpense(data);
      closeSheet();
      showToast(isIncome ? "Entrata aggiunta" : "Spesa aggiunta");
    });
  }

  /* ============================= TRANSACTION DETAIL SHEET ============================= */
  function openTransactionDetail(tx, kind) {
    kind = kind || "expense";
    var isIncome = kind === "income";
    var cat = catByslug(tx.category);
    var html =
      '<h3 style="text-align:center">Dettaglio ' + (isIncome ? "entrata" : "spesa") + '</h3>' +
      '<div class="detail-amount' + (isIncome ? " income" : "") + '">' + (isIncome ? "+" : "") + formatMoney(tx.amount) + '</div>' +
      '<div class="detail-cat"><span class="cat-dot" style="display:inline-block;background:' + safeColor(cat.color) + ';margin-right:6px;vertical-align:middle"></span>' + escapeHtml(cat.name) + '</div>' +
      '<div class="detail-row"><span>Data</span><span>' + formatDayHeading(tx.date) + '</span></div>' +
      (tx.note ? '<div class="detail-row"><span>Nota</span><span>' + escapeHtml(tx.note) + '</span></div>' : '') +
      (tx.recurringId ? '<div class="detail-row"><span>Origine</span><span>' + (isIncome ? "Entrata ricorrente" : "Spesa ricorrente") + '</span></div>' : '') +
      '<div style="margin-top:18px; display:flex; flex-direction:column; gap:10px">' +
      '<button type="button" class="btn-primary" id="editTxBtn" style="margin-top:0">Modifica</button>' +
      '<button type="button" class="btn-danger" id="deleteTxBtn">Elimina ' + (isIncome ? "entrata" : "spesa") + '</button>' +
      '<button type="button" class="btn-ghost" id="cancelDetailBtn">Chiudi</button>' +
      '</div>';
    openSheet(html);
    document.getElementById("cancelDetailBtn").addEventListener("click", closeSheet);
    document.getElementById("editTxBtn").addEventListener("click", function () {
      // Dati salvati del movimento, senza i campi aggiunti lato client.
      var data = Object.assign({}, tx);
      delete data.id; delete data._kind;
      openAddTransactionSheet(kind, {
        amount: formatAmountInput(tx.amount),
        date: tx.date,
        note: tx.note || "",
        category: tx.category
      }, { id: tx.id, kind: kind, data: data });
    });
    wireConfirmButton(document.getElementById("deleteTxBtn"), function () {
      if (isIncome) dbDeleteIncome(tx.id); else dbDeleteExpense(tx.id);
      closeSheet();
      showToast(isIncome ? "Entrata eliminata" : "Spesa eliminata");
    });
  }

  /* ============================= HOME VIEW ============================= */
  function recentTransactions(monthExpenses, monthIncomes, n) {
    var all = monthExpenses.map(function (e) { return Object.assign({ _kind: "expense" }, e); })
      .concat(monthIncomes.map(function (e) { return Object.assign({ _kind: "income" }, e); }));
    all.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (a.createdAt || "") < (b.createdAt || "") ? 1 : -1;
    });
    return all.slice(0, n);
  }
  function renderHome() {
    var el = document.getElementById("view-home");
    var monthExpenses = expensesForMonth(state.currentMonth);
    var monthIncomes = incomesForMonth(state.currentMonth);
    var expenseTotal = totalOf(monthExpenses);
    var incomeTotal = totalOf(monthIncomes);
    var net = incomeTotal - expenseTotal;
    var bySlug = sumByCategory(monthExpenses);
    // Il confronto col budget considera solo le categorie che ne hanno uno:
    // sommare anche le spese delle categorie senza limite falserebbe l'esito.
    var expenseCats = getCategories("expense");
    var budgeted = expenseCats.filter(function (c) { return (state.budgets[c.slug] || 0) > 0; });
    var totalBudget = budgeted.reduce(function (s, c) { return s + state.budgets[c.slug]; }, 0);
    var budgetedSpent = budgeted.reduce(function (s, c) { return s + (bySlug[c.slug] || 0); }, 0);
    var hasBudget = budgeted.length > 0;
    var pct = hasBudget ? budgetedSpent / totalBudget : 0;
    var status = statusForPct(pct);
    var remaining = totalBudget - budgetedSpent;

    var pendingRecurring = getPendingRecurring();

    var html = '<div class="card">' +
      '<div class="hero-label">Saldo a ' + formatMonthLabel(state.currentMonth) + '</div>' +
      '<div class="hero-amount num ' + signClass(net) + '">' + (net < 0 ? "−" : "") + formatMoney(Math.abs(net)) + '</div>' +
      '<div class="hero-split">' +
        '<span class="hero-split-item income"><span class="hero-split-dot"></span>Entrate <b class="num">' + formatMoney(incomeTotal) + '</b></span>' +
        '<span class="hero-split-item expense"><span class="hero-split-dot"></span>Uscite <b class="num">' + formatMoney(expenseTotal) + '</b></span>' +
      '</div>';
    if (hasBudget) {
      html += '<div class="meter-track"><div class="meter-fill ' + status + '" style="width:' + Math.min(100, pct * 100) + '%"></div></div>' +
        '<div class="status-row ' + status + '">' + statusIcon(status) + '<span>' + statusLabel(status) + ' — ' +
          (remaining >= 0
            ? formatMoney(remaining) + ' rimanenti su ' + formatMoney(totalBudget)
            : formatMoney(-remaining) + ' oltre il budget di ' + formatMoney(totalBudget)) +
        '</span></div>';
      if (budgeted.length < expenseCats.length) {
        html += '<div class="hero-sub">Calcolato ' + (budgeted.length === 1 ? "sull'unica categoria" : "sulle " + budgeted.length + " categorie") + ' con un budget.</div>';
      }
    } else {
      html += '<div class="hero-sub">Nessun budget impostato.</div>' +
        '<button class="link-btn" id="goSetBudget" style="margin-top:6px">Imposta un budget →</button>';
    }
    html += '</div>';

    if (pendingRecurring.length) {
      html += '<div class="banner-cta"><p><strong>' + pendingRecurring.length + '</strong> ' + (pendingRecurring.length === 1 ? "movimento ricorrente" : "movimenti ricorrenti") + ' da aggiungere.</p>' +
        '<button id="goRecurringBanner">Gestisci</button></div>';
    }

    var topCats = expenseCats.map(function (c) { return { cat: c, amount: bySlug[c.slug] || 0 }; })
      .filter(function (x) { return x.amount > 0; })
      .sort(function (a, b) { return b.amount - a.amount; })
      .slice(0, 3);
    if (topCats.length) {
      html += '<div class="section-title">Categorie principali</div><div class="card">' +
        topCats.map(function (x) {
          return '<div class="mini-cat-row"><span class="cat-dot" style="background:' + safeColor(x.cat.color) + '"></span>' +
            '<span class="mini-cat-name">' + escapeHtml(x.cat.name) + '</span><span class="mini-cat-amount num">' + formatMoney(x.amount) + '</span></div>';
        }).join("") + '</div>';
    }

    var recent = recentTransactions(monthExpenses, monthIncomes, 5);
    var totalCount = monthExpenses.length + monthIncomes.length;
    html += '<div class="section-title" style="display:flex;justify-content:space-between;align-items:center">' +
      '<span>Movimenti recenti</span>' + (totalCount > 5 ? '<button class="link-btn" id="seeAllBtn" style="margin:0">Vedi tutti</button>' : '') + '</div>';
    if (recent.length) {
      html += '<div class="card">' + recent.map(function (e) { return txRowHtml(e); }).join("") + '</div>';
    } else {
      html += emptyStateHtml("Nessun movimento registrato questo mese.", "Aggiungi il primo movimento", "emptyAddBtn");
    }

    el.innerHTML = html;

    var goSetBudget = document.getElementById("goSetBudget");
    if (goSetBudget) goSetBudget.addEventListener("click", function () { setView("budget"); });
    var goRecurringBanner = document.getElementById("goRecurringBanner");
    if (goRecurringBanner) goRecurringBanner.addEventListener("click", function () { setView("recurring"); });
    var seeAllBtn = document.getElementById("seeAllBtn");
    if (seeAllBtn) seeAllBtn.addEventListener("click", function () { setView("list"); });
    var emptyAddBtn = document.getElementById("emptyAddBtn");
    if (emptyAddBtn) emptyAddBtn.addEventListener("click", function () { openAddTransactionSheet("expense"); });
    wireTxRows(el);
  }

  function txRowHtml(e, kind) {
    kind = e._kind || kind || "expense";
    var isIncome = kind === "income";
    var cat = catByslug(e.category);
    var color = safeColor(cat.color);
    return '<button type="button" class="tx-row" data-id="' + escapeHtml(e.id) + '" data-kind="' + kind + '">' +
      '<span class="tx-icon" aria-hidden="true" style="background:' + color + ';color:' + readableTextOn(color) + '">' + escapeHtml(catInitial(e.category)) + '</span>' +
      '<span class="tx-main"><span class="tx-title">' + escapeHtml(e.note || cat.name) + '</span>' +
      '<span class="tx-sub">' + escapeHtml(cat.name) + ' · ' + formatShortDate(e.date) + '</span></span>' +
      '<span class="tx-amount num' + (isIncome ? " income" : "") + '">' + (isIncome ? "+" : "") + formatMoney(e.amount) + '</span></button>';
  }
  function wireTxRows(container) {
    container.querySelectorAll(".tx-row").forEach(function (row) {
      row.addEventListener("click", function () {
        var kind = row.dataset.kind || "expense";
        var list = kind === "income" ? state.incomes : state.expenses;
        var e = list.find(function (x) { return x.id === row.dataset.id; });
        if (e) openTransactionDetail(e, kind);
      });
    });
  }
  function emptyStateHtml(message, ctaLabel, ctaId) {
    return '<div class="empty-state">' +
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 10h18M8 4h8"/></svg>' +
      '<p>' + message + '</p>' +
      (ctaLabel ? '<button id="' + ctaId + '">' + ctaLabel + '</button>' : '') +
      '</div>';
  }

  /* ============================= LIST VIEW ============================= */
  function renderList() {
    var el = document.getElementById("view-list");
    var kind = state.listType;
    var isIncome = kind === "income";
    var monthList = isIncome ? incomesForMonth(state.currentMonth) : expensesForMonth(state.currentMonth);
    var filtered = state.listFilter === "all" ? monthList : monthList.filter(function (e) { return e.category === state.listFilter; });

    var toggle = '<div class="type-toggle" id="listTypeToggle">' +
      '<button type="button" class="type-toggle-btn' + (!isIncome ? " active" : "") + '" aria-pressed="' + !isIncome + '" data-kind="expense">Uscite</button>' +
      '<button type="button" class="type-toggle-btn' + (isIncome ? " active" : "") + '" aria-pressed="' + isIncome + '" data-kind="income">Entrate</button>' +
      '</div>';

    function chipHtml(slug, label, color) {
      var active = state.listFilter === slug;
      return '<button type="button" class="chip' + (active ? " active" : "") + '" aria-pressed="' + active + '" data-slug="' + escapeHtml(slug) + '">' +
        (color ? '<span class="cat-dot" style="background:' + safeColor(color) + '"></span>' : '') + escapeHtml(label) + '</button>';
    }
    var chips = '<div class="chip-row" id="listChips" role="group" aria-label="Filtra per categoria">' +
      chipHtml("all", "Tutte", null) +
      getCategories(kind).map(function (c) { return chipHtml(c.slug, c.name, c.color); }).join("") +
      '</div>';

    var body;
    if (!filtered.length) {
      body = emptyStateHtml("Nessuna " + (isIncome ? "entrata" : "spesa") + " da mostrare per questo filtro.", "Aggiungi " + (isIncome ? "un'entrata" : "una spesa"), "listEmptyAddBtn");
    } else {
      var byDay = {};
      var order = [];
      filtered.forEach(function (e) {
        if (!byDay[e.date]) { byDay[e.date] = []; order.push(e.date); }
        byDay[e.date].push(e);
      });
      order.sort().reverse();
      // Nello stesso giorno: prima i più recenti, come in Home.
      order.forEach(function (day) {
        byDay[day].sort(function (a, b) { return (a.createdAt || "") < (b.createdAt || "") ? 1 : -1; });
      });
      body = order.map(function (day) {
        return '<div class="day-heading">' + formatDayHeading(day) + '</div><div class="card">' +
          byDay[day].map(function (e) { return txRowHtml(e, kind); }).join("") + '</div>';
      }).join("");
    }

    el.innerHTML = toggle + chips + body;
    // Il re-render sostituisce i pulsanti: si rimette il focus su quello
    // appena premuto, altrimenti chi usa tastiera o screen reader lo perde.
    el.querySelectorAll("#listTypeToggle .type-toggle-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.listType = btn.dataset.kind;
        state.listFilter = "all";
        renderList();
        el.querySelector('#listTypeToggle [data-kind="' + state.listType + '"]').focus({ preventScroll: true });
      });
    });
    el.querySelectorAll("#listChips .chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var slug = chip.dataset.slug;
        state.listFilter = slug;
        renderList();
        var again = el.querySelector('#listChips [data-slug="' + CSS.escape(slug) + '"]');
        if (again) again.focus({ preventScroll: true });
      });
    });
    var listEmptyAddBtn = document.getElementById("listEmptyAddBtn");
    if (listEmptyAddBtn) listEmptyAddBtn.addEventListener("click", function () { openAddTransactionSheet(kind); });
    wireTxRows(el);
  }

  /* ============================= STATS VIEW ============================= */
  function categoryBarsHtml(rows, total, emptyMessage) {
    if (!rows.length) return emptyStateHtml(emptyMessage, null, null);
    var max = rows[0].amount;
    return '<div class="card">' + rows.map(function (x) {
      var pct = max ? (x.amount / max * 100) : 0;
      var share = total ? (x.amount / total * 100) : 0;
      return '<div class="bar-chart-row">' +
        '<div class="bar-chart-head"><span>' + escapeHtml(x.cat.name) + '</span><span class="num">' + formatMoney(x.amount) + '<span class="pct">' + share.toFixed(0) + '%</span></span></div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + safeColor(x.cat.color) + '"></div></div>' +
        '</div>';
    }).join("") + '</div>';
  }
  function renderStats() {
    var el = document.getElementById("view-stats");
    var monthExpenses = expensesForMonth(state.currentMonth);
    var monthIncomes = incomesForMonth(state.currentMonth);
    var expenseTotal = totalOf(monthExpenses);
    var incomeTotal = totalOf(monthIncomes);
    var net = incomeTotal - expenseTotal;

    var bySlugExpense = sumByCategory(monthExpenses);
    var bySlugIncome = sumByCategory(monthIncomes);
    var expenseRows = getCategories("expense").map(function (c) { return { cat: c, amount: bySlugExpense[c.slug] || 0 }; })
      .filter(function (x) { return x.amount > 0; }).sort(function (a, b) { return b.amount - a.amount; });
    var incomeRows = getCategories("income").map(function (c) { return { cat: c, amount: bySlugIncome[c.slug] || 0 }; })
      .filter(function (x) { return x.amount > 0; }).sort(function (a, b) { return b.amount - a.amount; });

    // Nel mese in corso si divide per i giorni trascorsi, non per quelli
    // totali; per i mesi futuri la media non ha senso.
    var thisMonth = monthKeyFromDate(new Date());
    var daysElapsed = state.currentMonth < thisMonth
      ? daysInMonth(parseInt(state.currentMonth.slice(0, 4), 10), parseInt(state.currentMonth.slice(5, 7), 10))
      : state.currentMonth === thisMonth ? new Date().getDate() : 0;
    var avgPerDayLabel = daysElapsed ? formatMoney(expenseTotal / daysElapsed) : "—";

    var html = '<div class="stat-tiles">' +
      '<div class="stat-tile"><div class="stat-tile-label">Entrate mese</div><div class="stat-tile-value num">' + formatMoney(incomeTotal) + '</div></div>' +
      '<div class="stat-tile"><div class="stat-tile-label">Uscite mese</div><div class="stat-tile-value num">' + formatMoney(expenseTotal) + '</div></div>' +
      '<div class="stat-tile"><div class="stat-tile-label">Saldo mese</div><div class="stat-tile-value num ' + signClass(net) + '">' + (net < 0 ? "−" : "") + formatMoney(Math.abs(net)) + '</div></div>' +
      '<div class="stat-tile"><div class="stat-tile-label">Media/giorno (uscite)</div><div class="stat-tile-value num">' + avgPerDayLabel + '</div></div>' +
      '</div>';

    html += '<div class="section-title">Uscite per categoria</div>';
    html += categoryBarsHtml(expenseRows, expenseTotal, "Nessuna spesa in questo mese: niente da mostrare ancora.");

    html += '<div class="section-title">Entrate per categoria</div>';
    html += categoryBarsHtml(incomeRows, incomeTotal, "Nessuna entrata in questo mese: niente da mostrare ancora.");

    html += '<div class="section-title">Andamento ultimi 6 mesi</div><div class="card trend-wrap" id="trendCard" style="position:relative"></div>';

    el.innerHTML = html;
    renderTrendChart(document.getElementById("trendCard"));
  }

  function renderTrendChart(container) {
    var months = [];
    for (var i = 5; i >= 0; i--) months.push(addMonths(state.currentMonth, -i));
    var expenseTotals = months.map(function (m) { return totalOf(expensesForMonth(m)); });
    var incomeTotals = months.map(function (m) { return totalOf(incomesForMonth(m)); });
    var max = Math.max.apply(null, expenseTotals.concat(incomeTotals).concat([1])) * 1.15;

    var W = 300, H = 130, padL = 4, padR = 4, padT = 12, padB = 22;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var stepX = innerW / (months.length - 1);
    function xAt(i) { return padL + i * stepX; }
    function yAt(v) { return padT + innerH - (v / max) * innerH; }

    // Ogni punto ha un cerchio visibile piccolo e uno trasparente più grande
    // che riceve il tocco: i soli marker (r 3.5) erano quasi impossibili da colpire.
    function buildSeries(totals, seriesKey, color) {
      var points = totals.map(function (v, i) { return [xAt(i), yAt(v)]; });
      var linePath = points.map(function (p, i) { return (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
      var markers = points.map(function (p, i) {
        var isLast = i === points.length - 1;
        var r = isLast ? 5 : 3.5;
        return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + r + '" fill="' + (isLast ? color : "var(--surface)") + '" stroke="' + color + '" stroke-width="2" pointer-events="none"/>';
      }).join("");
      var hits = points.map(function (p, i) {
        return '<circle class="trend-pt" data-i="' + i + '" data-series="' + seriesKey + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="12" fill="transparent" style="cursor:pointer"/>';
      }).join("");
      return { linePath: linePath, markers: markers, hits: hits };
    }

    var expenseSeries = buildSeries(expenseTotals, "expense", "var(--critical)");
    var incomeSeries = buildSeries(incomeTotals, "income", "var(--good)");

    // Linee guida con il relativo valore, così l'ordine di grandezza si
    // legge senza dover toccare i punti. Omesse se non ci sono dati.
    var hasData = expenseTotals.concat(incomeTotals).some(function (v) { return v > 0; });
    function compactMoney(v) {
      return v >= 1000
        ? (v / 1000).toLocaleString("it-IT", { maximumFractionDigits: 1 }) + "k €"
        : Math.round(v).toLocaleString("it-IT") + " €";
    }
    var gridLines = [0.33, 0.66, 1].map(function (f) {
      var y = padT + innerH * (1 - f);
      return '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="var(--gridline)" stroke-width="1"/>' +
        (hasData ? '<text x="' + (W - padR) + '" y="' + (y - 3).toFixed(1) + '" font-size="8.5" fill="var(--ink-muted)" text-anchor="end" font-family="var(--font-body)">' + compactMoney(max * f) + '</text>' : '');
    }).join("");

    var labels = months.map(function (m, i) {
      var d = new Date(parseInt(m.slice(0, 4), 10), parseInt(m.slice(5, 7), 10) - 1, 1);
      var lbl = d.toLocaleDateString("it-IT", { month: "short" }).replace(".", "");
      return '<text x="' + xAt(i).toFixed(1) + '" y="' + (H - 4) + '" font-size="9.5" fill="var(--ink-muted)" text-anchor="middle" font-family="var(--font-body)">' + lbl + '</text>';
    }).join("");

    // Per gli screen reader il grafico è un'immagine con i valori nel testo alternativo.
    var summary = "Andamento entrate e uscite negli ultimi sei mesi. " + months.map(function (m, i) {
      return formatMonthLabel(m) + ": uscite " + formatMoney(expenseTotals[i]) + ", entrate " + formatMoney(incomeTotals[i]);
    }).join("; ");
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + escapeHtml(summary) + '">' +
      gridLines +
      '<path d="' + expenseSeries.linePath + '" fill="none" stroke="var(--critical)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="' + incomeSeries.linePath + '" fill="none" stroke="var(--good)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      expenseSeries.markers + incomeSeries.markers +
      labels +
      expenseSeries.hits + incomeSeries.hits +
      '</svg>';

    container.innerHTML =
      '<div class="trend-legend"><span class="trend-legend-item"><span class="dot expense"></span>Uscite</span>' +
      '<span class="trend-legend-item"><span class="dot income"></span>Entrate</span></div>' + svg;

    var tooltip = null, tooltipTimer = null;
    container.querySelectorAll(".trend-pt").forEach(function (pt) {
      pt.addEventListener("click", function () {
        if (tooltip) tooltip.remove();
        clearTimeout(tooltipTimer);
        var i = parseInt(pt.dataset.i, 10);
        var seriesKey = pt.dataset.series;
        var value = seriesKey === "income" ? incomeTotals[i] : expenseTotals[i];
        // Coordinate relative alla card (che contiene il tooltip), non
        // all'SVG: vanno sommati padding e altezza della legenda.
        var svgRect = container.querySelector("svg").getBoundingClientRect();
        var boxRect = container.getBoundingClientRect();
        var scaleX = svgRect.width / W;
        var scaleY = svgRect.height / H;
        var cx = svgRect.left - boxRect.left + parseFloat(pt.getAttribute("cx")) * scaleX;
        var cy = svgRect.top - boxRect.top + parseFloat(pt.getAttribute("cy")) * scaleY;
        tooltip = document.createElement("div");
        tooltip.className = "trend-tooltip";
        tooltip.style.left = cx + "px";
        tooltip.style.top = cy + "px";
        tooltip.textContent = (seriesKey === "income" ? "Entrate " : "Uscite ") + formatMonthLabel(months[i]).split(" ")[0].replace(/^\w/, function (c) { return c.toUpperCase(); }) + " · " + formatMoney(value);
        container.appendChild(tooltip);
        tooltipTimer = setTimeout(function () { if (tooltip) { tooltip.remove(); tooltip = null; } }, 2200);
      });
    });
  }

  /* ============================= BUDGET VIEW ============================= */
  function budgetMeterHtml(limitVal, spent) {
    if (!(limitVal > 0)) return '<div class="budget-meter-line">Speso finora: ' + formatMoney(spent) + ' — nessun limite impostato</div>';
    var pct = spent / limitVal;
    return '<div class="meter-track"><div class="meter-fill ' + statusForPct(pct) + '" style="width:' + Math.min(100, pct * 100) + '%"></div></div>' +
      '<div class="budget-meter-line">' + formatMoney(spent) + ' di ' + formatMoney(limitVal) + ' (' + (pct * 100).toFixed(0) + '%)</div>';
  }
  function renderBudget() {
    var el = document.getElementById("view-budget");
    var bySlug = sumByCategory(expensesForMonth(state.currentMonth));
    var cats = getCategories("expense");

    // Se l'utente sta scrivendo in un campo, un re-render completo gli
    // toglierebbe focus e tastiera (succede a ogni salvataggio o sync):
    // finché le categorie sono le stesse si aggiornano solo le barre.
    var rows = el.querySelectorAll(".budget-row");
    var active = document.activeElement;
    var editing = active && active.classList.contains("budget-input") && el.contains(active);
    var sameRows = rows.length === cats.length && cats.every(function (c, i) { return rows[i].dataset.slug === c.slug; });
    if (editing && sameRows) {
      cats.forEach(function (c, i) {
        var limitVal = state.budgets[c.slug] || 0;
        rows[i].querySelector(".budget-meter").innerHTML = budgetMeterHtml(limitVal, bySlug[c.slug] || 0);
        var input = rows[i].querySelector(".budget-input");
        if (input !== active) input.value = formatAmountInput(limitVal);
      });
      return;
    }

    var html = '<p style="font-size:13px;color:var(--ink-secondary);margin-bottom:14px">Imposta un tetto di spesa mensile per categoria. Il limite vale per tutti i mesi.</p>';
    html += '<div class="card">' + cats.map(function (c) {
      var limitVal = state.budgets[c.slug] || 0;
      return '<div class="budget-row" data-slug="' + escapeHtml(c.slug) + '">' +
        '<div class="budget-row-head"><span class="cat-dot" style="background:' + safeColor(c.color) + '"></span>' +
        '<span class="mini-cat-name">' + escapeHtml(c.name) + '</span></div>' +
        '<div class="budget-input-wrap"><span>€</span><input type="text" inputmode="decimal" autocomplete="off" class="budget-input" value="' + formatAmountInput(limitVal) + '" placeholder="0" data-slug="' + escapeHtml(c.slug) + '" aria-label="Budget ' + escapeHtml(c.name) + '"></div>' +
        '<div class="budget-meter">' + budgetMeterHtml(limitVal, bySlug[c.slug] || 0) + '</div>' +
        '</div>';
    }).join("") + '</div>';

    el.innerHTML = html;
    el.querySelectorAll(".budget-input").forEach(function (input) {
      input.addEventListener("change", function () {
        var val = input.value.trim() === "" ? 0 : parseAmount(input.value);
        if (isNaN(val)) { showToast("Inserisci un importo valido."); input.value = formatAmountInput(state.budgets[input.dataset.slug] || 0); return; }
        val = Math.round(val * 100) / 100;
        if (val === (state.budgets[input.dataset.slug] || 0)) return;
        dbSetBudget(input.dataset.slug, val);
        showToast("Budget aggiornato");
      });
    });
  }

  /* ============================= RECURRING VIEW ============================= */
  var FREQ_UNIT_LABELS = { week: ["settimana", "settimane"], month: ["mese", "mesi"], year: ["anno", "anni"] };
  function frequencyLabel(r) {
    var n = parseInt(r.interval, 10) || 1;
    var words = FREQ_UNIT_LABELS[r.frequencyUnit] || FREQ_UNIT_LABELS.month;
    return n === 1 ? "ogni " + words[0] : "ogni " + n + " " + words[1];
  }
  // Sposta una data ISO avanti di `interval` unità (settimana/mese/anno).
  // Per mesi e anni si parte da `anchorDay`, il giorno originale della
  // ricorrenza, e lo si accorcia solo se il mese è più corto: così
  // 31 gen → 28 feb → 31 mar, invece di restare bloccati al 28.
  function advanceDate(iso, unit, interval, anchorDay) {
    var parts = iso.split("-").map(function (n) { return parseInt(n, 10); });
    var y = parts[0], m = parts[1], d = parts[2];
    if (unit === "week") return isoFromDate(new Date(y, m - 1, d + 7 * interval));
    var day = anchorDay || d;
    if (unit === "year") {
      var ny = y + interval;
      return ny + "-" + pad2(m) + "-" + pad2(Math.min(day, daysInMonth(ny, m)));
    }
    var totalMonths = (m - 1) + interval;
    var newY = y + Math.floor(totalMonths / 12);
    var newM = (totalMonths % 12) + 1;
    return newY + "-" + pad2(newM) + "-" + pad2(Math.min(day, daysInMonth(newY, newM)));
  }
  // I documenti precedenti ad `anchorDay` usano `dayOfMonth` (formato
  // legacy) o, in mancanza, il giorno della prossima scadenza.
  function recurringAnchorDay(r) {
    return parseInt(r.anchorDay, 10) || parseInt(r.dayOfMonth, 10) || parseInt(getNextDueDate(r).slice(8, 10), 10);
  }
  // Ricorrenti create prima dell'introduzione delle frequenze flessibili
  // avevano solo `dayOfMonth` + `lastAppliedMonth`: qui si deriva la prossima
  // scadenza per quei documenti finché non vengono migrati al primo utilizzo.
  function getNextDueDate(r) {
    if (r.nextDueDate) return r.nextDueDate;
    var day = parseInt(r.dayOfMonth, 10) || 1;
    var base = r.lastAppliedMonth ? addMonths(r.lastAppliedMonth, 1) : monthKeyFromDate(new Date());
    var y = parseInt(base.slice(0, 4), 10), m = parseInt(base.slice(5, 7), 10);
    return base + "-" + pad2(Math.min(day, daysInMonth(y, m)));
  }
  function getPendingRecurring() {
    var today = todayISO();
    return state.recurring.filter(function (r) { return r.active && getNextDueDate(r) <= today; });
  }
  function recurringKind(r){ return r.kind === "income" ? "income" : "expense"; }

  function recurringSectionHtml(title, list, kind, addBtnId, emptyBtnId) {
    var html = '<div class="section-title" style="display:flex;justify-content:space-between;align-items:center"><span>' + title + '</span>' +
      '<button type="button" class="recurring-add-btn" id="' + addBtnId + '" aria-label="' + (kind === "income" ? "Aggiungi entrata ricorrente" : "Aggiungi spesa ricorrente") + '">+ Nuova</button></div>';
    if (list.length) {
      html += '<div class="card">' + list.map(function (r) {
        var cat = catByslug(r.category);
        var isIncome = kind === "income";
        return '<div class="recurring-row" data-id="' + escapeHtml(r.id) + '">' +
          '<span class="cat-dot" style="background:' + safeColor(cat.color) + '"></span>' +
          '<button type="button" class="recurring-main"><span class="recurring-title">' + escapeHtml(r.name) + '</span>' +
          '<span class="recurring-sub">' + (isIncome ? "+" : "") + formatMoney(r.amount) + ' · ' + frequencyLabel(r) + ' · ' + escapeHtml(cat.name) + '</span></button>' +
          '<button type="button" class="switch' + (r.active ? " on" : "") + '" role="switch" aria-checked="' + !!r.active + '" data-toggle="' + escapeHtml(r.id) + '" aria-label="' + escapeHtml(r.name) + ' attiva"></button>' +
          '</div>';
      }).join("") + '</div>';
    } else {
      html += emptyStateHtml(
        kind === "income" ? "Nessuna entrata ricorrente configurata. Aggiungi lo stipendio o altre entrate fisse." : "Nessuna spesa ricorrente configurata. Aggiungi abbonamenti o bollette che si ripetono nel tempo.",
        "Aggiungi ricorrente", emptyBtnId
      );
    }
    return html;
  }

  function renderRecurring() {
    var el = document.getElementById("view-recurring");
    var pending = getPendingRecurring();
    var expenseRecurring = state.recurring.filter(function (r) { return recurringKind(r) === "expense"; });
    var incomeRecurring = state.recurring.filter(function (r) { return recurringKind(r) === "income"; });
    var html = "";

    if (pending.length) {
      html += '<div class="section-title">Da aggiungere</div><div class="card">' +
        pending.map(function (r) {
          var cat = catByslug(r.category);
          var isIncome = recurringKind(r) === "income";
          return '<div class="pending-item" data-id="' + escapeHtml(r.id) + '"><span class="cat-dot" style="background:' + safeColor(cat.color) + '"></span>' +
            '<div class="tx-main"><div class="tx-title">' + escapeHtml(r.name) + '</div><div class="tx-sub">' + escapeHtml(cat.name) + ' · ' + formatShortDate(getNextDueDate(r)) + ' · ' + (isIncome ? "+" : "") + formatMoney(r.amount) + '</div></div>' +
            '<button type="button" class="btn-small" data-apply="' + escapeHtml(r.id) + '" aria-label="Aggiungi ' + escapeHtml(r.name) + '">Aggiungi</button></div>';
        }).join("") +
        (pending.length > 1 ? '<button class="btn-ghost" id="applyAllBtn" style="margin-top:12px">Aggiungi tutte (' + pending.length + ')</button>' : "") +
        '</div>';
    }

    html += recurringSectionHtml("Spese ricorrenti", expenseRecurring, "expense", "addRecurringExpBtn", "recurringEmptyAddBtnExpense");
    html += recurringSectionHtml("Entrate ricorrenti", incomeRecurring, "income", "addRecurringIncBtn", "recurringEmptyAddBtnIncome");

    el.innerHTML = html;

    el.querySelectorAll("[data-apply]").forEach(function (btn) {
      btn.addEventListener("click", function () { btn.disabled = true; applyRecurring(btn.dataset.apply); });
    });
    var applyAllBtn = document.getElementById("applyAllBtn");
    if (applyAllBtn) applyAllBtn.addEventListener("click", function () {
      getPendingRecurring().forEach(function (r) { applyRecurring(r.id); });
    });
    el.querySelectorAll("[data-toggle]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var r = state.recurring.find(function (x) { return x.id === btn.dataset.toggle; });
        if (r) dbUpdateRecurring(r.id, { active: !r.active });
      });
    });
    el.querySelectorAll(".recurring-row").forEach(function (row) {
      row.addEventListener("click", function (e) {
        if (e.target.closest("[data-toggle]")) return;
        var r = state.recurring.find(function (x) { return x.id === row.dataset.id; });
        if (r) openRecurringDetail(r);
      });
    });
    var addRecurringExpBtn = document.getElementById("addRecurringExpBtn");
    if (addRecurringExpBtn) addRecurringExpBtn.addEventListener("click", function () { openAddRecurringSheet("expense"); });
    var addRecurringIncBtn = document.getElementById("addRecurringIncBtn");
    if (addRecurringIncBtn) addRecurringIncBtn.addEventListener("click", function () { openAddRecurringSheet("income"); });
    var recurringEmptyAddBtnExpense = document.getElementById("recurringEmptyAddBtnExpense");
    if (recurringEmptyAddBtnExpense) recurringEmptyAddBtnExpense.addEventListener("click", function () { openAddRecurringSheet("expense"); });
    var recurringEmptyAddBtnIncome = document.getElementById("recurringEmptyAddBtnIncome");
    if (recurringEmptyAddBtnIncome) recurringEmptyAddBtnIncome.addEventListener("click", function () { openAddRecurringSheet("income"); });
  }

  // id ricorrente → scadenza già registrata. Evita il doppio inserimento se
  // si tocca due volte (o "Aggiungi tutte") prima che lo stato si aggiorni.
  var appliedRecurring = {};
  function applyRecurring(id) {
    var r = state.recurring.find(function (x) { return x.id === id; });
    if (!r) return;
    var dueDate = getNextDueDate(r);
    if (appliedRecurring[r.id] === dueDate) return;
    appliedRecurring[r.id] = dueDate;
    var unit = r.frequencyUnit || "month";
    var interval = parseInt(r.interval, 10) || 1;
    var anchorDay = recurringAnchorDay(r);
    var kind = recurringKind(r);
    var data = {
      amount: Number(r.amount) || 0,
      category: r.category,
      date: dueDate,
      note: r.name,
      recurringId: r.id,
      createdAt: new Date().toISOString()
    };
    dbApplyRecurring(kind, data, r.id, {
      kind: kind,
      frequencyUnit: unit,
      interval: interval,
      anchorDay: anchorDay,
      nextDueDate: advanceDate(dueDate, unit, interval, anchorDay)
    }).then(function (ok) { if (!ok) delete appliedRecurring[r.id]; });
    showToast("Aggiunta: " + r.name);
  }

  function openAddRecurringSheet(kind) {
    kind = kind || "expense";
    var isIncome = kind === "income";
    var defaultCat = isIncome ? "stipendio" : "abbonamenti";
    var html = '<form id="recForm" novalidate>' +
      '<h3>' + (isIncome ? "Nuova entrata ricorrente" : "Nuova spesa ricorrente") + '</h3>' +
      '<div class="field"><label for="recName">Nome</label><input type="text" id="recName" placeholder="' + (isIncome ? "Es. Stipendio" : "Es. Abbonamento palestra") + '" maxlength="80"></div>' +
      '<div class="field amount-field"><label for="recAmount">Importo</label><input type="text" id="recAmount" inputmode="decimal" autocomplete="off" placeholder="0,00"></div>' +
      '<div class="field"><span class="field-label">Categoria</span>' + categoryGridHtml(defaultCat, "recCatGrid", kind) + '</div>' +
      '<div class="field"><span class="field-label" id="recFreqLabel">Frequenza</span><div class="freq-row" role="group" aria-labelledby="recFreqLabel">' +
        '<div class="field"><input type="number" inputmode="numeric" id="recInterval" min="1" max="99" value="1" aria-label="Ogni quanti"></div>' +
        '<div class="field"><select id="recUnit" aria-label="Unità">' +
          '<option value="week">Settimane</option>' +
          '<option value="month" selected>Mesi</option>' +
          '<option value="year">Anni</option>' +
        '</select></div>' +
      '</div></div>' +
      '<div class="field"><label for="recNextDate">Prossima scadenza</label><input type="date" id="recNextDate" value="' + todayISO() + '"></div>' +
      '<button type="submit" class="btn-primary">Salva</button>' +
      '</form>';
    openSheet(html);
    var selectedCat = defaultCat;
    wireCategoryGrid("recCatGrid", function (slug) { selectedCat = slug; }, kind);

    var intervalInput = document.getElementById("recInterval");
    var unitSelect = document.getElementById("recUnit");
    function updateUnitLabels() {
      var n = parseInt(intervalInput.value, 10) || 1;
      unitSelect.options[0].textContent = n === 1 ? "Settimana" : "Settimane";
      unitSelect.options[1].textContent = n === 1 ? "Mese" : "Mesi";
      unitSelect.options[2].textContent = n === 1 ? "Anno" : "Anni";
    }
    intervalInput.addEventListener("input", updateUnitLabels);
    updateUnitLabels();

    document.getElementById("recForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = document.getElementById("recName").value.trim();
      var amount = parseAmount(document.getElementById("recAmount").value);
      var interval = parseInt(intervalInput.value, 10);
      var unit = unitSelect.value;
      var nextDate = document.getElementById("recNextDate").value || todayISO();
      if (!name) { showToast("Inserisci un nome."); return; }
      if (!amount || amount <= 0) { showToast("Inserisci un importo valido."); return; }
      if (!interval || interval < 1) interval = 1;
      dbAddRecurring({
        name: name,
        amount: Math.round(amount * 100) / 100,
        category: selectedCat,
        frequencyUnit: unit,
        interval: interval,
        anchorDay: parseInt(nextDate.slice(8, 10), 10),
        nextDueDate: nextDate,
        active: true,
        kind: kind
      });
      closeSheet();
      showToast(isIncome ? "Entrata ricorrente salvata" : "Spesa ricorrente salvata");
    });
  }

  function openRecurringDetail(r) {
    var kind = recurringKind(r);
    var isIncome = kind === "income";
    var cat = catByslug(r.category);
    var html = '<h3 style="text-align:center">' + escapeHtml(r.name) + '</h3>' +
      '<div class="detail-amount' + (isIncome ? " income" : "") + '">' + (isIncome ? "+" : "") + formatMoney(r.amount) + '</div>' +
      '<div class="detail-cat"><span class="cat-dot" style="display:inline-block;background:' + safeColor(cat.color) + ';margin-right:6px;vertical-align:middle"></span>' + escapeHtml(cat.name) + '</div>' +
      '<div class="detail-row"><span>Tipo</span><span>' + (isIncome ? "Entrata" : "Spesa") + '</span></div>' +
      '<div class="detail-row"><span>Frequenza</span><span>' + frequencyLabel(r) + '</span></div>' +
      '<div class="detail-row"><span>Stato</span><span>' + (r.active ? "Attiva" : "In pausa") + '</span></div>' +
      '<div class="detail-row"><span>Prossima scadenza</span><span>' + formatShortDate(getNextDueDate(r)) + '</span></div>' +
      '<div style="margin-top:18px; display:flex; flex-direction:column; gap:10px">' +
      '<button class="btn-danger" id="deleteRecBtn">Elimina ricorrente</button>' +
      '<button class="btn-ghost" id="closeRecDetailBtn">Chiudi</button></div>';
    openSheet(html);
    document.getElementById("closeRecDetailBtn").addEventListener("click", closeSheet);
    wireConfirmButton(document.getElementById("deleteRecBtn"), function () {
      dbDeleteRecurring(r.id);
      closeSheet();
      showToast("Ricorrente eliminata");
    });
  }

  /* ============================= PWA: SERVICE WORKER ============================= */
  var isLocalDev = ["localhost", "127.0.0.1"].indexOf(location.hostname) !== -1;
  if ("serviceWorker" in navigator && !isLocalDev) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function () { /* non-fatal */ });
    });
  }

  // Al cambio di tema i colori delle categorie cambiano, e con loro il
  // colore di testo leggibile calcolato in readableTextOn.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderCurrentView);

  /* ============================= INIT ============================= */
  updateMonthLabel();
  setView("home");
  updateStatusBanner();
})();
