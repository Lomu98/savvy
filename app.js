// Savvy — app di tracciamento spese personali.
// Backend: Firebase Authentication (Google Sign-In) + Firestore.
// Ogni utente autenticato legge/scrive solo sotto users/{uid}/... —
// vedi firestore.rules per l'applicazione lato server di questa regola.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache,
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, writeBatch,
  onSnapshot, query, where, orderBy
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

(function () {
  "use strict";

  /* ============================= VIEWPORT HEIGHT (PWA fix) ============================= */
  // Su alcune PWA iOS in standalone, 100dvh non include l'area sotto
  // l'indicatore home nonostante viewport-fit=cover: si misura l'altezza
  // reale via JS (fonte di verità del browser) invece di fidarsi delle
  // unità CSS, che su questo caso specifico si sono rivelate inaffidabili.
  // Subito dopo il cold-launch da home screen, però, window.innerHeight
  // può restituire per un istante un valore troppo basso (WebKit non ha
  // ancora assestato il layout fullscreen): senza un resize successivo
  // quel valore sbagliato resta fisso per sempre, lasciando lo spazio
  // vuoto sotto la tabbar. Si ri-misura quindi anche dopo il primo
  // frame e ad ogni volta che l'app torna in primo piano.
  function setAppHeight() {
    document.documentElement.style.setProperty("--app-height", window.innerHeight + "px");
  }
  setAppHeight();
  requestAnimationFrame(function () { requestAnimationFrame(setAppHeight); });
  window.addEventListener("resize", setAppHeight);
  window.addEventListener("orientationchange", function () { setTimeout(setAppHeight, 100); });
  window.addEventListener("pageshow", setAppHeight);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) setAppHeight();
  });

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
  function formatShortDate(iso){
    var d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("it-IT", { day: "numeric", month: "short" });
  }

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
    // sync automatically once the connection returns.
    dbFs = initializeFirestore(firebaseApp, { localCache: persistentLocalCache() });
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
      '<button class="btn-danger" id="signOutBtn">Esci</button>';
    openSheet(html);
    document.getElementById("signOutBtn").addEventListener("click", function () {
      closeSheet();
      signOut(auth);
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
  function openSheet(html) {
    document.getElementById("sheetContent").innerHTML = html;
    document.getElementById("sheetOverlay").hidden = false;
  }
  function closeSheet() {
    document.getElementById("sheetOverlay").hidden = true;
    document.getElementById("sheetContent").innerHTML = "";
  }
  document.getElementById("sheetOverlay").addEventListener("click", function (e) {
    if (e.target.id === "sheetOverlay") closeSheet();
  });

  /* ============================= NAVIGATION ============================= */
  function setView(view) {
    state.currentView = view;
    document.querySelectorAll(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-" + view); });
    document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.view === view); });
    document.getElementById("views").scrollTop = 0;
    renderCurrentView();
  }
  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { setView(btn.dataset.view); });
  });
  document.getElementById("fabAdd").addEventListener("click", function () {
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
    var grid = '<div class="cat-grid" id="' + name + '">' + getCategories(kind).map(function (c) {
      return '<div class="cat-opt' + (c.slug === selectedSlug ? " selected" : "") + '" data-slug="' + escapeHtml(c.slug) + '">' +
        '<span class="cat-dot" style="background:' + safeColor(c.color) + '"></span><span>' + escapeHtml(c.name) + '</span></div>';
    }).join("") +
      '<div class="cat-opt cat-opt-add" data-slug="__add__"><span class="cat-dot-add">+</span><span>Nuova</span></div>' +
      '</div>';
    var form = '<div class="new-cat-form" id="' + name + 'NewCat" hidden>' +
      '<div class="new-cat-form-row">' +
        '<input type="text" class="new-cat-name" placeholder="Nome categoria" maxlength="30">' +
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
      grid.querySelectorAll(".cat-opt").forEach(function (o) { o.classList.remove("selected"); });
      opt.classList.add("selected");
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
    form.querySelector(".new-cat-cancel").addEventListener("click", function () { form.hidden = true; });
    form.querySelector(".new-cat-save").addEventListener("click", function () {
      var name = form.querySelector(".new-cat-name").value.trim();
      var color = form.querySelector(".new-cat-color").value;
      if (!name) { showToast("Inserisci un nome per la categoria."); return; }
      var slug = uniqueCategorySlug(name);
      var newCat = { slug: slug, name: name, color: color, kind: kind, custom: true };
      state.customCategories.push(newCat);
      dbAddCategory(slug, name, color, kind);

      var tile = document.createElement("div");
      tile.className = "cat-opt";
      tile.dataset.slug = slug;
      tile.innerHTML = '<span class="cat-dot" style="background:' + safeColor(color) + '"></span><span>' + escapeHtml(name) + '</span>';
      grid.insertBefore(tile, addOpt);
      wireOpt(tile);
      selectOpt(tile);

      form.hidden = true;
      form.querySelector(".new-cat-name").value = "";
      showToast("Categoria creata");
    });
  }

  /* ============================= ADD TRANSACTION SHEET ============================= */
  var lastUsedExpenseCategory = DEFAULT_EXPENSE_CATEGORIES[0].slug;
  var lastUsedIncomeCategory = DEFAULT_INCOME_CATEGORIES[0].slug;
  function openAddTransactionSheet(kind, prefill) {
    kind = kind || "expense";
    var isIncome = kind === "income";
    var lastUsed = isIncome ? lastUsedIncomeCategory : lastUsedExpenseCategory;
    prefill = prefill || {};
    var html =
      '<h3>Nuovo movimento</h3>' +
      '<div class="type-toggle" id="txTypeToggle">' +
        '<button type="button" class="type-toggle-btn' + (!isIncome ? " active" : "") + '" data-kind="expense">Spesa</button>' +
        '<button type="button" class="type-toggle-btn' + (isIncome ? " active" : "") + '" data-kind="income">Entrata</button>' +
      '</div>' +
      '<div class="field amount-field"><label for="txAmount">Importo</label>' +
        '<input type="text" id="txAmount" inputmode="decimal" autocomplete="off" placeholder="0,00" autofocus></div>' +
      '<div class="field"><label>Categoria</label>' + categoryGridHtml(lastUsed, "addCatGrid", kind) + '</div>' +
      '<div class="field"><label for="txDate">Data</label><input type="date" id="txDate" value="' + todayISO() + '"></div>' +
      '<div class="field"><label for="txNote">Nota (opzionale)</label><input type="text" id="txNote" placeholder="' + (isIncome ? "Es. Bonifico stipendio" : "Es. Spesa al supermercato") + '" maxlength="120"></div>' +
      '<button class="btn-primary" id="saveTxBtn">' + (isIncome ? "Aggiungi entrata" : "Aggiungi spesa") + '</button>';
    openSheet(html);
    if (prefill.amount) document.getElementById("txAmount").value = prefill.amount;
    if (prefill.date) document.getElementById("txDate").value = prefill.date;
    if (prefill.note) document.getElementById("txNote").value = prefill.note;

    document.querySelectorAll("#txTypeToggle .type-toggle-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.kind === kind) return;
        openAddTransactionSheet(btn.dataset.kind, {
          amount: document.getElementById("txAmount").value,
          date: document.getElementById("txDate").value,
          note: document.getElementById("txNote").value
        });
      });
    });

    var selectedCat = lastUsed;
    wireCategoryGrid("addCatGrid", function (slug) { selectedCat = slug; }, kind);
    document.getElementById("saveTxBtn").addEventListener("click", function () {
      var amountVal = parseAmount(document.getElementById("txAmount").value);
      var dateVal = document.getElementById("txDate").value || todayISO();
      var noteVal = document.getElementById("txNote").value.trim();
      if (!amountVal || amountVal <= 0) { showToast("Inserisci un importo valido."); return; }
      if (isIncome) lastUsedIncomeCategory = selectedCat; else lastUsedExpenseCategory = selectedCat;
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
      '<button class="btn-danger" id="deleteTxBtn">Elimina ' + (isIncome ? "entrata" : "spesa") + '</button>' +
      '<button class="btn-ghost" id="cancelDetailBtn">Chiudi</button>' +
      '</div>';
    openSheet(html);
    document.getElementById("cancelDetailBtn").addEventListener("click", closeSheet);
    document.getElementById("deleteTxBtn").addEventListener("click", function () {
      var btn = this;
      if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.textContent = "Conferma eliminazione";
        return;
      }
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
      '<div class="hero-amount num ' + (net < 0 ? "negative" : "positive") + '">' + (net < 0 ? "−" : "") + formatMoney(Math.abs(net)) + '</div>' +
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
      '<span>Transazioni recenti</span>' + (totalCount > 5 ? '<button class="link-btn" id="seeAllBtn" style="margin:0">Vedi tutte</button>' : '') + '</div>';
    if (recent.length) {
      html += '<div class="card">' + recent.map(function (e) { return txRowHtml(e); }).join("") + '</div>';
    } else {
      html += emptyStateHtml("Nessuna transazione registrata questo mese.", "Aggiungi la prima transazione", "emptyAddBtn");
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
    return '<div class="tx-row" data-id="' + escapeHtml(e.id) + '" data-kind="' + kind + '">' +
      '<div class="tx-icon" style="background:' + safeColor(cat.color) + '">' + escapeHtml(catInitial(e.category)) + '</div>' +
      '<div class="tx-main"><div class="tx-title">' + escapeHtml(e.note || cat.name) + '</div>' +
      '<div class="tx-sub">' + escapeHtml(cat.name) + ' · ' + formatShortDate(e.date) + '</div></div>' +
      '<div class="tx-amount num' + (isIncome ? " income" : "") + '">' + (isIncome ? "+" : "") + formatMoney(e.amount) + '</div></div>';
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
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 10h18M8 4h8"/></svg>' +
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
      '<button class="type-toggle-btn' + (!isIncome ? " active" : "") + '" data-kind="expense">Uscite</button>' +
      '<button class="type-toggle-btn' + (isIncome ? " active" : "") + '" data-kind="income">Entrate</button>' +
      '</div>';

    var chips = '<div class="chip-row" id="listChips">' +
      '<div class="chip' + (state.listFilter === "all" ? " active" : "") + '" data-slug="all">Tutte</div>' +
      getCategories(kind).map(function (c) {
        return '<div class="chip' + (state.listFilter === c.slug ? " active" : "") + '" data-slug="' + escapeHtml(c.slug) + '">' +
          '<span class="cat-dot" style="background:' + safeColor(c.color) + '"></span>' + escapeHtml(c.name) + '</div>';
      }).join("") + '</div>';

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
      body = order.map(function (day) {
        return '<div class="day-heading">' + formatDayHeading(day) + '</div><div class="card">' +
          byDay[day].map(function (e) { return txRowHtml(e, kind); }).join("") + '</div>';
      }).join("");
    }

    el.innerHTML = toggle + chips + body;
    document.querySelectorAll("#listTypeToggle .type-toggle-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.listType = btn.dataset.kind;
        state.listFilter = "all";
        renderList();
      });
    });
    document.querySelectorAll("#listChips .chip").forEach(function (chip) {
      chip.addEventListener("click", function () { state.listFilter = chip.dataset.slug; renderList(); });
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
      '<div class="stat-tile"><div class="stat-tile-label">Saldo mese</div><div class="stat-tile-value num" style="color:' + (net < 0 ? "var(--critical)" : "var(--good)") + '">' + (net < 0 ? "−" : "") + formatMoney(Math.abs(net)) + '</div></div>' +
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

    function buildSeries(totals, seriesKey, color) {
      var points = totals.map(function (v, i) { return [xAt(i), yAt(v)]; });
      var linePath = points.map(function (p, i) { return (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
      var markers = points.map(function (p, i) {
        var isLast = i === points.length - 1;
        var r = isLast ? 5 : 3.5;
        return '<circle class="trend-pt" data-i="' + i + '" data-series="' + seriesKey + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + r + '" fill="' + (isLast ? color : "var(--surface)") + '" stroke="' + color + '" stroke-width="2" style="cursor:pointer"/>';
      }).join("");
      return { linePath: linePath, markers: markers };
    }

    var expenseSeries = buildSeries(expenseTotals, "expense", "var(--critical)");
    var incomeSeries = buildSeries(incomeTotals, "income", "var(--good)");

    var gridLines = [0.33, 0.66, 1].map(function (f) {
      var y = padT + innerH * (1 - f);
      return '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="var(--gridline)" stroke-width="1"/>';
    }).join("");

    var labels = months.map(function (m, i) {
      var d = new Date(parseInt(m.slice(0, 4), 10), parseInt(m.slice(5, 7), 10) - 1, 1);
      var lbl = d.toLocaleDateString("it-IT", { month: "short" }).replace(".", "");
      return '<text x="' + xAt(i).toFixed(1) + '" y="' + (H - 4) + '" font-size="9.5" fill="var(--ink-muted)" text-anchor="middle" font-family="var(--font-body)">' + lbl + '</text>';
    }).join("");

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-label="Andamento entrate e uscite negli ultimi sei mesi">' +
      gridLines +
      '<path d="' + expenseSeries.linePath + '" fill="none" stroke="var(--critical)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="' + incomeSeries.linePath + '" fill="none" stroke="var(--good)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      expenseSeries.markers + incomeSeries.markers +
      labels +
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
        var svgRect = container.querySelector("svg").getBoundingClientRect();
        var scaleX = svgRect.width / W;
        var scaleY = svgRect.height / H;
        var cx = parseFloat(pt.getAttribute("cx")) * scaleX;
        var cy = parseFloat(pt.getAttribute("cy")) * scaleY;
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
  function formatBudgetInput(limitVal) {
    return limitVal ? String(limitVal).replace(".", ",") : "";
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
        if (input !== active) input.value = formatBudgetInput(limitVal);
      });
      return;
    }

    var html = '<p style="font-size:13px;color:var(--ink-secondary);margin-bottom:14px">Imposta un tetto di spesa mensile per categoria. Il limite vale per tutti i mesi.</p>';
    html += '<div class="card">' + cats.map(function (c) {
      var limitVal = state.budgets[c.slug] || 0;
      return '<div class="budget-row" data-slug="' + escapeHtml(c.slug) + '">' +
        '<div class="budget-row-head"><span class="cat-dot" style="background:' + safeColor(c.color) + '"></span>' +
        '<span class="mini-cat-name">' + escapeHtml(c.name) + '</span></div>' +
        '<div class="budget-input-wrap"><span>€</span><input type="text" inputmode="decimal" autocomplete="off" class="budget-input" value="' + formatBudgetInput(limitVal) + '" placeholder="0" data-slug="' + escapeHtml(c.slug) + '" aria-label="Budget ' + escapeHtml(c.name) + '"></div>' +
        '<div class="budget-meter">' + budgetMeterHtml(limitVal, bySlug[c.slug] || 0) + '</div>' +
        '</div>';
    }).join("") + '</div>';

    el.innerHTML = html;
    el.querySelectorAll(".budget-input").forEach(function (input) {
      input.addEventListener("change", function () {
        var val = input.value.trim() === "" ? 0 : parseAmount(input.value);
        if (isNaN(val)) { showToast("Inserisci un importo valido."); input.value = formatBudgetInput(state.budgets[input.dataset.slug] || 0); return; }
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
      '<button class="recurring-add-btn" id="' + addBtnId + '">+ Nuova</button></div>';
    if (list.length) {
      html += '<div class="card">' + list.map(function (r) {
        var cat = catByslug(r.category);
        var isIncome = kind === "income";
        return '<div class="recurring-row" data-id="' + escapeHtml(r.id) + '">' +
          '<span class="cat-dot" style="background:' + safeColor(cat.color) + '"></span>' +
          '<div class="recurring-main"><div class="recurring-title">' + escapeHtml(r.name) + '</div>' +
          '<div class="recurring-sub">' + (isIncome ? "+" : "") + formatMoney(r.amount) + ' · ' + frequencyLabel(r) + ' · ' + escapeHtml(cat.name) + '</div></div>' +
          '<button class="switch' + (r.active ? " on" : "") + '" data-toggle="' + escapeHtml(r.id) + '" aria-label="Attiva o disattiva"></button>' +
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
            '<button class="btn-small" data-apply="' + escapeHtml(r.id) + '">Aggiungi</button></div>';
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
    var html = '<h3>' + (isIncome ? "Nuova entrata ricorrente" : "Nuova spesa ricorrente") + '</h3>' +
      '<div class="field"><label for="recName">Nome</label><input type="text" id="recName" placeholder="' + (isIncome ? "Es. Stipendio" : "Es. Abbonamento palestra") + '" maxlength="80"></div>' +
      '<div class="field amount-field"><label for="recAmount">Importo</label><input type="text" id="recAmount" inputmode="decimal" autocomplete="off" placeholder="0,00"></div>' +
      '<div class="field"><label>Categoria</label>' + categoryGridHtml(defaultCat, "recCatGrid", kind) + '</div>' +
      '<div class="field"><label>Frequenza</label><div class="freq-row">' +
        '<div class="field"><input type="number" id="recInterval" min="1" max="99" value="1"></div>' +
        '<div class="field"><select id="recUnit">' +
          '<option value="week">Settimane</option>' +
          '<option value="month" selected>Mesi</option>' +
          '<option value="year">Anni</option>' +
        '</select></div>' +
      '</div></div>' +
      '<div class="field"><label for="recNextDate">Prossima scadenza</label><input type="date" id="recNextDate" value="' + todayISO() + '"></div>' +
      '<button class="btn-primary" id="saveRecurringBtn">Salva</button>';
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

    document.getElementById("saveRecurringBtn").addEventListener("click", function () {
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
    document.getElementById("deleteRecBtn").addEventListener("click", function () {
      var btn = this;
      if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Conferma eliminazione"; return; }
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

  /* ============================= INIT ============================= */
  updateMonthLabel();
  setView("home");
  updateStatusBanner();
})();
