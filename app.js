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
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

(function () {
  "use strict";

  /* ============================= DATA ============================= */
  var DEFAULT_CATEGORIES = [
    { slug: "alimentari",  name: "Alimentari",      color: "var(--cat-alimentari)" },
    { slug: "trasporti",   name: "Trasporti",       color: "var(--cat-trasporti)" },
    { slug: "casa",        name: "Casa e bollette", color: "var(--cat-casa)" },
    { slug: "svago",       name: "Svago",           color: "var(--cat-svago)" },
    { slug: "salute",      name: "Salute",          color: "var(--cat-salute)" },
    { slug: "shopping",    name: "Shopping",        color: "var(--cat-shopping)" },
    { slug: "abbonamenti", name: "Abbonamenti",     color: "var(--cat-abbonamenti)" },
    { slug: "altro",       name: "Altro",           color: "var(--cat-altro)" }
  ];
  function getCategories(){ return DEFAULT_CATEGORIES.concat(state.customCategories); }
  function catByslug(slug){ return getCategories().find(function(c){ return c.slug === slug; }) || DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length-1]; }
  function catInitial(slug){ return catByslug(slug).name.charAt(0).toUpperCase(); }
  function slugify(s){
    return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "categoria";
  }
  function uniqueCategorySlug(name){
    var base = slugify(name), slug = base, n = 2;
    var existing = getCategories();
    while (existing.some(function(c){ return c.slug === slug; })) { slug = base + "-" + n; n++; }
    return slug;
  }

  /* ============================= STATE ============================= */
  var state = {
    expenses: [],
    budgets: {},
    recurring: [],
    customCategories: [],
    currentMonth: monthKeyFromDate(new Date()),
    currentView: "home",
    listFilter: "all"
  };
  var toastTimer = null;

  function todayISO(){ return new Date().toISOString().slice(0,10); }
  function monthKeyFromDate(d){ return d.toISOString().slice(0,7); }
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
  function escapeHtml(s){
    var d = document.createElement("div"); d.textContent = s; return d.innerHTML;
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
  var unsubExpenses = null, unsubBudgets = null, unsubRecurring = null, unsubCategories = null;

  function userCollection(name){ return collection(dbFs, "users", currentUser.uid, name); }
  function userDoc(name, id){ return doc(dbFs, "users", currentUser.uid, name, id); }

  onAuthStateChanged(auth, function (user) {
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
  function showApp(user) {
    document.getElementById("authScreen").hidden = true;
    document.getElementById("app").hidden = false;
    var btn = document.getElementById("accountBtn");
    if (user.photoURL) {
      btn.innerHTML = '<img src="' + user.photoURL + '" alt="">';
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
  function subscribeAll() {
    unsubscribeAll();
    try {
      var expensesQuery = query(userCollection("expenses"), orderBy("date", "desc"), limit(1000));
      unsubExpenses = onSnapshot(expensesQuery, function (snap) {
        state.expenses = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        renderCurrentView();
      }, function () { /* connectivity banner covers persistent failures */ });

      unsubBudgets = onSnapshot(userCollection("budgets"), function (snap) {
        var map = {};
        snap.docs.forEach(function (d) { var data = d.data(); map[d.id] = Number(data.limit) || 0; });
        state.budgets = map;
        renderCurrentView();
      }, function () {});

      unsubRecurring = onSnapshot(userCollection("recurring"), function (snap) {
        state.recurring = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        renderCurrentView();
      }, function () {});

      unsubCategories = onSnapshot(userCollection("categories"), function (snap) {
        state.customCategories = snap.docs.map(function (d) {
          return { slug: d.id, name: d.data().name, color: d.data().color, custom: true };
        });
        renderCurrentView();
      }, function () {});
    } catch (e) { /* connectivity banner covers this */ }
  }
  function unsubscribeAll() {
    if (unsubExpenses) unsubExpenses();
    if (unsubBudgets) unsubBudgets();
    if (unsubRecurring) unsubRecurring();
    if (unsubCategories) unsubCategories();
    unsubExpenses = unsubBudgets = unsubRecurring = unsubCategories = null;
    state.expenses = []; state.budgets = {}; state.recurring = []; state.customCategories = [];
  }

  function dbAddExpense(data) {
    return addDoc(userCollection("expenses"), data).catch(function () { showToast("Non salvato: controlla la connessione."); });
  }
  function dbDeleteExpense(id) {
    return deleteDoc(userDoc("expenses", id)).catch(function () { showToast("Eliminazione non riuscita."); });
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
  function dbAddCategory(slug, name, color) {
    return setDoc(userDoc("categories", slug), { name: name, color: color }).catch(function () { showToast("Categoria non salvata."); });
  }

  /* ============================= CONNECTIVITY BANNER ============================= */
  function updateConnectivityBanner() {
    var banner = document.getElementById("offlineBanner");
    if (navigator.onLine) {
      banner.hidden = true;
    } else {
      banner.hidden = false;
      banner.textContent = "Sei offline: le modifiche verranno sincronizzate automaticamente quando torni online.";
    }
  }
  window.addEventListener("online", updateConnectivityBanner);
  window.addEventListener("offline", updateConnectivityBanner);

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
  document.getElementById("fabAdd").addEventListener("click", openAddExpenseSheet);

  document.getElementById("prevMonthBtn").addEventListener("click", function () {
    state.currentMonth = addMonths(state.currentMonth, -1);
    updateMonthLabel(); renderCurrentView();
  });
  document.getElementById("nextMonthBtn").addEventListener("click", function () {
    state.currentMonth = addMonths(state.currentMonth, 1);
    updateMonthLabel(); renderCurrentView();
  });
  document.getElementById("goToTodayBtn").addEventListener("click", function () {
    state.currentMonth = monthKeyFromDate(new Date());
    updateMonthLabel(); renderCurrentView();
  });
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
  var CATEGORY_COLOR_PALETTE = ["#2a78d6","#eb6834","#1baf7a","#eda100","#e87ba4","#008300","#4a3aa7","#e34948","#0aa5a8","#b5539a"];
  function randomCategoryColor(){ return CATEGORY_COLOR_PALETTE[Math.floor(Math.random() * CATEGORY_COLOR_PALETTE.length)]; }

  function categoryGridHtml(selectedSlug, name) {
    var grid = '<div class="cat-grid" id="' + name + '">' + getCategories().map(function (c) {
      return '<div class="cat-opt' + (c.slug === selectedSlug ? " selected" : "") + '" data-slug="' + c.slug + '">' +
        '<span class="cat-dot" style="background:' + c.color + '"></span><span>' + escapeHtml(c.name) + '</span></div>';
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
  function wireCategoryGrid(gridId, onSelect) {
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
      var newCat = { slug: slug, name: name, color: color, custom: true };
      state.customCategories.push(newCat);
      dbAddCategory(slug, name, color);

      var tile = document.createElement("div");
      tile.className = "cat-opt";
      tile.dataset.slug = slug;
      tile.innerHTML = '<span class="cat-dot" style="background:' + color + '"></span><span>' + escapeHtml(name) + '</span>';
      grid.insertBefore(tile, addOpt);
      wireOpt(tile);
      selectOpt(tile);

      form.hidden = true;
      form.querySelector(".new-cat-name").value = "";
      showToast("Categoria creata");
    });
  }

  /* ============================= ADD EXPENSE SHEET ============================= */
  var lastUsedCategory = DEFAULT_CATEGORIES[0].slug;
  function openAddExpenseSheet() {
    var html =
      '<h3>Nuova spesa</h3>' +
      '<div class="field amount-field"><label for="expAmount">Importo</label>' +
        '<input type="number" id="expAmount" inputmode="decimal" step="0.01" min="0" placeholder="0,00" autofocus></div>' +
      '<div class="field"><label>Categoria</label>' + categoryGridHtml(lastUsedCategory, "addCatGrid") + '</div>' +
      '<div class="field"><label for="expDate">Data</label><input type="date" id="expDate" value="' + todayISO() + '"></div>' +
      '<div class="field"><label for="expNote">Nota (opzionale)</label><input type="text" id="expNote" placeholder="Es. Spesa al supermercato" maxlength="120"></div>' +
      '<button class="btn-primary" id="saveExpenseBtn">Aggiungi spesa</button>';
    openSheet(html);
    var selectedCat = lastUsedCategory;
    wireCategoryGrid("addCatGrid", function (slug) { selectedCat = slug; });
    document.getElementById("saveExpenseBtn").addEventListener("click", function () {
      var amountVal = parseFloat(document.getElementById("expAmount").value);
      var dateVal = document.getElementById("expDate").value || todayISO();
      var noteVal = document.getElementById("expNote").value.trim();
      if (!amountVal || amountVal <= 0) { showToast("Inserisci un importo valido."); return; }
      lastUsedCategory = selectedCat;
      dbAddExpense({
        amount: Math.round(amountVal * 100) / 100,
        category: selectedCat,
        date: dateVal,
        note: noteVal,
        recurringId: null,
        createdAt: new Date().toISOString()
      });
      closeSheet();
      showToast("Spesa aggiunta");
    });
  }

  /* ============================= EXPENSE DETAIL SHEET ============================= */
  function openExpenseDetail(expense) {
    var cat = catByslug(expense.category);
    var html =
      '<h3 style="text-align:center">Dettaglio spesa</h3>' +
      '<div class="detail-amount">' + formatMoney(expense.amount) + '</div>' +
      '<div class="detail-cat"><span class="cat-dot" style="display:inline-block;background:' + cat.color + ';margin-right:6px;vertical-align:middle"></span>' + cat.name + '</div>' +
      '<div class="detail-row"><span>Data</span><span>' + formatDayHeading(expense.date) + '</span></div>' +
      (expense.note ? '<div class="detail-row"><span>Nota</span><span>' + escapeHtml(expense.note) + '</span></div>' : '') +
      (expense.recurringId ? '<div class="detail-row"><span>Origine</span><span>Spesa ricorrente</span></div>' : '') +
      '<div style="margin-top:18px; display:flex; flex-direction:column; gap:10px">' +
      '<button class="btn-danger" id="deleteExpBtn">Elimina spesa</button>' +
      '<button class="btn-ghost" id="cancelDetailBtn">Chiudi</button>' +
      '</div>';
    openSheet(html);
    document.getElementById("cancelDetailBtn").addEventListener("click", closeSheet);
    document.getElementById("deleteExpBtn").addEventListener("click", function () {
      var btn = this;
      if (btn.dataset.armed !== "1") {
        btn.dataset.armed = "1";
        btn.textContent = "Conferma eliminazione";
        return;
      }
      dbDeleteExpense(expense.id);
      closeSheet();
      showToast("Spesa eliminata");
    });
  }

  /* ============================= HOME VIEW ============================= */
  function renderHome() {
    var el = document.getElementById("view-home");
    var monthExpenses = expensesForMonth(state.currentMonth);
    var total = totalOf(monthExpenses);
    var totalBudget = Object.keys(state.budgets).reduce(function (s, k) { return s + (Number(state.budgets[k]) || 0); }, 0);
    var hasBudget = totalBudget > 0;
    var pct = hasBudget ? total / totalBudget : 0;
    var status = statusForPct(pct);

    var pendingRecurring = getPendingRecurring();

    var html = '<div class="card">' +
      '<div class="hero-label">Speso a ' + formatMonthLabel(state.currentMonth) + '</div>' +
      '<div class="hero-amount num">' + formatMoney(total) + '</div>';
    if (hasBudget) {
      html += '<div class="meter-track"><div class="meter-fill ' + status + '" style="width:' + Math.min(100, pct * 100) + '%"></div></div>' +
        '<div class="status-row ' + status + '">' + statusIcon(status) + '<span>' + statusLabel(status) + ' — ' + formatMoney(totalBudget - total >= 0 ? totalBudget - total : total - totalBudget) + (totalBudget - total >= 0 ? ' rimanenti' : ' oltre il budget di ' + formatMoney(totalBudget)) + '</span></div>';
    } else {
      html += '<div class="hero-sub">Nessun budget impostato per questo mese.</div>' +
        '<button class="link-btn" id="goSetBudget" style="margin-top:6px">Imposta un budget →</button>';
    }
    html += '</div>';

    if (pendingRecurring.length) {
      html += '<div class="banner-cta"><p><strong>' + pendingRecurring.length + '</strong> ' + (pendingRecurring.length === 1 ? "spesa ricorrente" : "spese ricorrenti") + ' da aggiungere.</p>' +
        '<button id="goRecurringBanner">Gestisci</button></div>';
    }

    var bySlug = sumByCategory(monthExpenses);
    var topCats = getCategories().map(function (c) { return { cat: c, amount: bySlug[c.slug] || 0 }; })
      .filter(function (x) { return x.amount > 0; })
      .sort(function (a, b) { return b.amount - a.amount; })
      .slice(0, 3);
    if (topCats.length) {
      html += '<div class="section-title">Categorie principali</div><div class="card">' +
        topCats.map(function (x) {
          return '<div class="mini-cat-row"><span class="cat-dot" style="background:' + x.cat.color + '"></span>' +
            '<span class="mini-cat-name">' + x.cat.name + '</span><span class="mini-cat-amount num">' + formatMoney(x.amount) + '</span></div>';
        }).join("") + '</div>';
    }

    var recent = monthExpenses.slice(0, 5);
    html += '<div class="section-title" style="display:flex;justify-content:space-between;align-items:center">' +
      '<span>Spese recenti</span>' + (monthExpenses.length > 5 ? '<button class="link-btn" id="seeAllBtn" style="margin:0">Vedi tutte</button>' : '') + '</div>';
    if (recent.length) {
      html += '<div class="card">' + recent.map(txRowHtml).join("") + '</div>';
    } else {
      html += emptyStateHtml("Nessuna spesa registrata questo mese.", "Aggiungi la prima spesa", "emptyAddBtn");
    }

    el.innerHTML = html;

    var goSetBudget = document.getElementById("goSetBudget");
    if (goSetBudget) goSetBudget.addEventListener("click", function () { setView("budget"); });
    var goRecurringBanner = document.getElementById("goRecurringBanner");
    if (goRecurringBanner) goRecurringBanner.addEventListener("click", function () { setView("recurring"); });
    var seeAllBtn = document.getElementById("seeAllBtn");
    if (seeAllBtn) seeAllBtn.addEventListener("click", function () { setView("list"); });
    var emptyAddBtn = document.getElementById("emptyAddBtn");
    if (emptyAddBtn) emptyAddBtn.addEventListener("click", openAddExpenseSheet);
    wireTxRows(el);
  }

  function txRowHtml(e) {
    var cat = catByslug(e.category);
    return '<div class="tx-row" data-id="' + e.id + '">' +
      '<div class="tx-icon" style="background:' + cat.color + '">' + catInitial(e.category) + '</div>' +
      '<div class="tx-main"><div class="tx-title">' + (e.note ? escapeHtml(e.note) : cat.name) + '</div>' +
      '<div class="tx-sub">' + cat.name + ' · ' + formatShortDate(e.date) + '</div></div>' +
      '<div class="tx-amount num">' + formatMoney(e.amount) + '</div></div>';
  }
  function wireTxRows(container) {
    container.querySelectorAll(".tx-row").forEach(function (row) {
      row.addEventListener("click", function () {
        var e = state.expenses.find(function (x) { return x.id === row.dataset.id; });
        if (e) openExpenseDetail(e);
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
    var monthExpenses = expensesForMonth(state.currentMonth);
    var filtered = state.listFilter === "all" ? monthExpenses : monthExpenses.filter(function (e) { return e.category === state.listFilter; });

    var chips = '<div class="chip-row" id="listChips">' +
      '<div class="chip' + (state.listFilter === "all" ? " active" : "") + '" data-slug="all">Tutte</div>' +
      getCategories().map(function (c) {
        return '<div class="chip' + (state.listFilter === c.slug ? " active" : "") + '" data-slug="' + c.slug + '">' +
          '<span class="cat-dot" style="background:' + c.color + '"></span>' + escapeHtml(c.name) + '</div>';
      }).join("") + '</div>';

    var body;
    if (!filtered.length) {
      body = emptyStateHtml("Nessuna spesa da mostrare per questo filtro.", "Aggiungi una spesa", "listEmptyAddBtn");
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
          byDay[day].map(txRowHtml).join("") + '</div>';
      }).join("");
    }

    el.innerHTML = chips + body;
    document.querySelectorAll("#listChips .chip").forEach(function (chip) {
      chip.addEventListener("click", function () { state.listFilter = chip.dataset.slug; renderList(); });
    });
    var listEmptyAddBtn = document.getElementById("listEmptyAddBtn");
    if (listEmptyAddBtn) listEmptyAddBtn.addEventListener("click", openAddExpenseSheet);
    wireTxRows(el);
  }

  /* ============================= STATS VIEW ============================= */
  function renderStats() {
    var el = document.getElementById("view-stats");
    var monthExpenses = expensesForMonth(state.currentMonth);
    var bySlug = sumByCategory(monthExpenses);
    var total = totalOf(monthExpenses);
    var rows = getCategories().map(function (c) { return { cat: c, amount: bySlug[c.slug] || 0 }; })
      .filter(function (x) { return x.amount > 0; })
      .sort(function (a, b) { return b.amount - a.amount; });
    var max = rows.length ? rows[0].amount : 0;

    var avgPerDay = total / daysInMonth(parseInt(state.currentMonth.slice(0, 4), 10), parseInt(state.currentMonth.slice(5, 7), 10));

    var html = '<div class="stat-tiles">' +
      '<div class="stat-tile"><div class="stat-tile-label">Totale mese</div><div class="stat-tile-value num">' + formatMoney(total) + '</div></div>' +
      '<div class="stat-tile"><div class="stat-tile-label">Media giornaliera</div><div class="stat-tile-value num">' + formatMoney(avgPerDay) + '</div></div>' +
      '</div>';

    html += '<div class="section-title">Per categoria</div>';
    if (rows.length) {
      html += '<div class="card">' + rows.map(function (x) {
        var pct = max ? (x.amount / max * 100) : 0;
        var share = total ? (x.amount / total * 100) : 0;
        return '<div class="bar-chart-row">' +
          '<div class="bar-chart-head"><span>' + x.cat.name + '</span><span class="num">' + formatMoney(x.amount) + '<span class="pct">' + share.toFixed(0) + '%</span></span></div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + x.cat.color + '"></div></div>' +
          '</div>';
      }).join("") + '</div>';
    } else {
      html += emptyStateHtml("Nessuna spesa in questo mese: niente da mostrare ancora.", null, null);
    }

    html += '<div class="section-title">Andamento ultimi 6 mesi</div><div class="card trend-wrap" id="trendCard" style="position:relative"></div>';

    el.innerHTML = html;
    renderTrendChart(document.getElementById("trendCard"));
  }

  function renderTrendChart(container) {
    var months = [];
    for (var i = 5; i >= 0; i--) months.push(addMonths(state.currentMonth, -i));
    var totals = months.map(function (m) { return totalOf(expensesForMonth(m)); });
    var max = Math.max.apply(null, totals.concat([1])) * 1.15;

    var W = 300, H = 130, padL = 4, padR = 4, padT = 12, padB = 22;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var stepX = innerW / (months.length - 1);
    function xAt(i) { return padL + i * stepX; }
    function yAt(v) { return padT + innerH - (v / max) * innerH; }

    var points = totals.map(function (v, i) { return [xAt(i), yAt(v)]; });
    var linePath = points.map(function (p, i) { return (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
    var areaPath = linePath + " L" + xAt(points.length - 1).toFixed(1) + "," + (padT + innerH) + " L" + xAt(0).toFixed(1) + "," + (padT + innerH) + " Z";

    var gridLines = [0.33, 0.66, 1].map(function (f) {
      var y = padT + innerH * (1 - f);
      return '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="var(--gridline)" stroke-width="1"/>';
    }).join("");

    var markers = points.map(function (p, i) {
      var isLast = i === points.length - 1;
      var r = isLast ? 5 : 3.5;
      return '<circle class="trend-pt" data-i="' + i + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + r + '" fill="' + (isLast ? "var(--accent)" : "var(--surface)") + '" stroke="var(--accent)" stroke-width="2" style="cursor:pointer"/>';
    }).join("");

    var labels = months.map(function (m, i) {
      var d = new Date(parseInt(m.slice(0, 4), 10), parseInt(m.slice(5, 7), 10) - 1, 1);
      var lbl = d.toLocaleDateString("it-IT", { month: "short" }).replace(".", "");
      return '<text x="' + xAt(i).toFixed(1) + '" y="' + (H - 4) + '" font-size="9.5" fill="var(--ink-muted)" text-anchor="middle" font-family="var(--font-body)">' + lbl + '</text>';
    }).join("");

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-label="Andamento spesa negli ultimi sei mesi">' +
      gridLines +
      '<defs><linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="var(--accent)" stop-opacity="0.22"/>' +
        '<stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path d="' + areaPath + '" fill="url(#trendGrad)"/>' +
      '<path d="' + linePath + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      markers +
      labels +
      '</svg>';

    container.innerHTML = svg;
    var tooltip = null;
    container.querySelectorAll(".trend-pt").forEach(function (pt) {
      pt.addEventListener("click", function () {
        if (tooltip) tooltip.remove();
        var i = parseInt(pt.dataset.i, 10);
        var svgRect = container.querySelector("svg").getBoundingClientRect();
        var scaleX = svgRect.width / W;
        var scaleY = svgRect.height / H;
        var cx = parseFloat(pt.getAttribute("cx")) * scaleX;
        var cy = parseFloat(pt.getAttribute("cy")) * scaleY;
        tooltip = document.createElement("div");
        tooltip.className = "trend-tooltip";
        tooltip.style.left = cx + "px";
        tooltip.style.top = cy + "px";
        tooltip.textContent = formatMonthLabel(months[i]).split(" ")[0].replace(/^\w/, function (c) { return c.toUpperCase(); }) + " · " + formatMoney(totals[i]);
        container.appendChild(tooltip);
        setTimeout(function () { if (tooltip) { tooltip.remove(); tooltip = null; } }, 2200);
      });
    });
  }

  /* ============================= BUDGET VIEW ============================= */
  function renderBudget() {
    var el = document.getElementById("view-budget");
    var monthExpenses = expensesForMonth(state.currentMonth);
    var bySlug = sumByCategory(monthExpenses);

    var html = '<p style="font-size:13px;color:var(--ink-secondary);margin-bottom:14px">Imposta un tetto di spesa mensile per categoria. Le modifiche si applicano da ' + formatMonthLabel(state.currentMonth) + ' in poi.</p>';
    html += '<div class="card">' + getCategories().map(function (c) {
      var limitVal = state.budgets[c.slug] || 0;
      var spent = bySlug[c.slug] || 0;
      var pct = limitVal > 0 ? spent / limitVal : 0;
      var status = limitVal > 0 ? statusForPct(pct) : null;
      return '<div class="budget-row" data-slug="' + c.slug + '">' +
        '<div class="budget-row-head"><span class="cat-dot" style="background:' + c.color + '"></span>' +
        '<span class="mini-cat-name">' + escapeHtml(c.name) + '</span></div>' +
        '<div class="budget-input-wrap"><span>€</span><input type="number" class="budget-input" min="0" step="1" value="' + (limitVal || "") + '" placeholder="0" data-slug="' + c.slug + '"></div>' +
        (limitVal > 0 ?
          ('<div class="meter-track"><div class="meter-fill ' + status + '" style="width:' + Math.min(100, pct * 100) + '%"></div></div>' +
           '<div class="budget-meter-line">' + formatMoney(spent) + ' di ' + formatMoney(limitVal) + ' (' + (pct * 100).toFixed(0) + '%)</div>')
          : '<div class="budget-meter-line">Speso finora: ' + formatMoney(spent) + ' — nessun limite impostato</div>') +
        '</div>';
    }).join("") + '</div>';

    el.innerHTML = html;
    el.querySelectorAll(".budget-input").forEach(function (input) {
      input.addEventListener("change", function () {
        var val = parseFloat(input.value);
        if (isNaN(val) || val < 0) val = 0;
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
  // Sposta una data ISO avanti di `interval` unità (settimana/mese/anno),
  // mantenendo il giorno del mese quando possibile (es. 31 gen + 1 mese -> 28/29 feb).
  function advanceDate(iso, unit, interval) {
    var parts = iso.split("-").map(function (n) { return parseInt(n, 10); });
    var y = parts[0], m = parts[1], d = parts[2];
    if (unit === "week") {
      var dt = new Date(y, m - 1, d + 7 * interval);
      return dt.getFullYear() + "-" + pad2(dt.getMonth() + 1) + "-" + pad2(dt.getDate());
    }
    if (unit === "year") {
      var ny = y + interval;
      return ny + "-" + pad2(m) + "-" + pad2(Math.min(d, daysInMonth(ny, m)));
    }
    var totalMonths = (m - 1) + interval;
    var newY = y + Math.floor(totalMonths / 12);
    var newM = (totalMonths % 12) + 1;
    return newY + "-" + pad2(newM) + "-" + pad2(Math.min(d, daysInMonth(newY, newM)));
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
  function renderRecurring() {
    var el = document.getElementById("view-recurring");
    var pending = getPendingRecurring();
    var html = "";

    if (pending.length) {
      html += '<div class="section-title">Da aggiungere questo mese</div><div class="card">' +
        pending.map(function (r) {
          var cat = catByslug(r.category);
          return '<div class="pending-item" data-id="' + r.id + '"><span class="cat-dot" style="background:' + cat.color + '"></span>' +
            '<div class="tx-main"><div class="tx-title">' + escapeHtml(r.name) + '</div><div class="tx-sub">' + cat.name + ' · ' + formatMoney(r.amount) + '</div></div>' +
            '<button class="btn-small" data-apply="' + r.id + '">Aggiungi</button></div>';
        }).join("") +
        (pending.length > 1 ? '<button class="btn-ghost" id="applyAllBtn" style="margin-top:12px">Aggiungi tutte (' + pending.length + ')</button>' : "") +
        '</div>';
    }

    html += '<div class="section-title" style="display:flex;justify-content:space-between;align-items:center"><span>Spese ricorrenti</span>' +
      '<button class="recurring-add-btn" id="addRecurringBtn">+ Nuova</button></div>';

    if (state.recurring.length) {
      html += '<div class="card">' + state.recurring.map(function (r) {
        var cat = catByslug(r.category);
        return '<div class="recurring-row" data-id="' + r.id + '">' +
          '<span class="cat-dot" style="background:' + cat.color + '"></span>' +
          '<div class="recurring-main"><div class="recurring-title">' + escapeHtml(r.name) + '</div>' +
          '<div class="recurring-sub">' + formatMoney(r.amount) + ' · ' + frequencyLabel(r) + ' · ' + cat.name + '</div></div>' +
          '<button class="switch' + (r.active ? " on" : "") + '" data-toggle="' + r.id + '" aria-label="Attiva o disattiva"></button>' +
          '</div>';
      }).join("") + '</div>';
    } else {
      html += emptyStateHtml("Nessuna spesa ricorrente configurata. Aggiungi abbonamenti o bollette che si ripetono nel tempo.", "Aggiungi ricorrente", "recurringEmptyAddBtn");
    }

    el.innerHTML = html;

    el.querySelectorAll("[data-apply]").forEach(function (btn) {
      btn.addEventListener("click", function () { applyRecurring(btn.dataset.apply); });
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
    var addRecurringBtn = document.getElementById("addRecurringBtn");
    if (addRecurringBtn) addRecurringBtn.addEventListener("click", openAddRecurringSheet);
    var recurringEmptyAddBtn = document.getElementById("recurringEmptyAddBtn");
    if (recurringEmptyAddBtn) recurringEmptyAddBtn.addEventListener("click", openAddRecurringSheet);
  }

  function applyRecurring(id) {
    var r = state.recurring.find(function (x) { return x.id === id; });
    if (!r) return;
    var dueDate = getNextDueDate(r);
    var unit = r.frequencyUnit || "month";
    var interval = parseInt(r.interval, 10) || 1;
    dbAddExpense({
      amount: Number(r.amount) || 0,
      category: r.category,
      date: dueDate,
      note: r.name,
      recurringId: r.id,
      createdAt: new Date().toISOString()
    });
    dbUpdateRecurring(r.id, {
      frequencyUnit: unit,
      interval: interval,
      nextDueDate: advanceDate(dueDate, unit, interval)
    });
    showToast("Aggiunta: " + r.name);
  }

  function openAddRecurringSheet() {
    var html = '<h3>Nuova spesa ricorrente</h3>' +
      '<div class="field"><label for="recName">Nome</label><input type="text" id="recName" placeholder="Es. Abbonamento palestra" maxlength="80"></div>' +
      '<div class="field amount-field"><label for="recAmount">Importo</label><input type="number" id="recAmount" inputmode="decimal" step="0.01" min="0" placeholder="0,00"></div>' +
      '<div class="field"><label>Categoria</label>' + categoryGridHtml("abbonamenti", "recCatGrid") + '</div>' +
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
    var selectedCat = "abbonamenti";
    wireCategoryGrid("recCatGrid", function (slug) { selectedCat = slug; });

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
      var amount = parseFloat(document.getElementById("recAmount").value);
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
        nextDueDate: nextDate,
        active: true
      });
      closeSheet();
      showToast("Spesa ricorrente salvata");
    });
  }

  function openRecurringDetail(r) {
    var cat = catByslug(r.category);
    var html = '<h3 style="text-align:center">' + escapeHtml(r.name) + '</h3>' +
      '<div class="detail-amount">' + formatMoney(r.amount) + '</div>' +
      '<div class="detail-cat"><span class="cat-dot" style="display:inline-block;background:' + cat.color + ';margin-right:6px;vertical-align:middle"></span>' + cat.name + '</div>' +
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
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function () { /* non-fatal */ });
    });
  }

  /* ============================= INIT ============================= */
  updateMonthLabel();
  setView("home");
  updateConnectivityBanner();
})();
