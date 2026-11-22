"use strict";
// Rundblick – Web-Version (Test für iPhone und andere Browser).
// Die Berechnungen entsprechen der Android-App (Kotlin), damit beide gleich funktionieren.

// ---------------------------------------------------------------------------
// Einstellungen (pro Gerät im Browser gespeichert)
// ---------------------------------------------------------------------------
const TYPEN = {
  GIPFEL: "⛰️", ORT: "🏘️", BURG: "🏰", SEE: "💧", AUSSICHT: "👁️", SEHENSWUERDIGKEIT: "🏛️"
};
const ALLE_TYPEN = Object.keys(TYPEN);
const STANDARD = { radiusKm: 30, maxLabels: 10, korrektur: 0, kategorien: ALLE_TYPEN };

function einstLaden() {
  try { return { ...STANDARD, ...JSON.parse(localStorage.getItem("rundblick") || "{}") }; }
  catch { return { ...STANDARD }; }
}
function einstSpeichern() {
  try { localStorage.setItem("rundblick", JSON.stringify(einst)); } catch { /* privat-Modus */ }
}
let einst = einstLaden();

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------
const DEMO = new URLSearchParams(location.search).has("demo");
const DEKLINATION = 3;          // Abweichung magnetisch/geografisch Nord in der Schweiz (ca.)
const KAMERA_HALB_TAN_KURZ = 0.52; // Kamera-Bildwinkel (Hochformat, quer), ca. 55°
const KAMERA_HALB_TAN_LANG = 0.69; // Kamera-Bildwinkel (Hochformat, hoch), ca. 69°
const FOKUS_GRAD = 4, FOKUS_HALTEN_GRAD = 7;

let alleOrte = null;            // alle Orte aus pois.tsv
let pois = [];                  // Orte im Umkreis
let lat = null, lon = null;
let rohRichtung = null;         // Kompass inkl. Deklination, ohne Nutzer-Korrektur
let sinAvg = 0, cosAvg = 0, kompassInit = false;
let fokus = null;
let ladenFuer = null;           // Position, für die pois zuletzt berechnet wurden
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Geometrie (wie MainActivity.kt)
// ---------------------------------------------------------------------------
const RAD = Math.PI / 180;
function richtungZu(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}
function distanzKm(lat1, lon1, lat2, lon2) {
  const dp = (lat2 - lat1) * RAD, dl = (lon2 - lon1) * RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dl / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
const kurzRichtung = (g) => t("richtungen_kurz")[Math.floor((g + 22.5) / 45) % 8];
const langRichtung = (g) => t("richtungen_lang")[Math.floor((g + 22.5) / 45) % 8];
const zahl = (x, n = 1) => x.toLocaleString(SPRACHE === "en" ? "en" : SPRACHE + "-CH",
  { minimumFractionDigits: n, maximumFractionDigits: n });
const km = (d) => d < 1 ? `${Math.floor(d * 100) * 10} m` : `${zahl(d)} km`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const imDatengebiet = (la, lo) => la >= 45.6 && la <= 48.0 && lo >= 5.6 && lo <= 10.8;

// ---------------------------------------------------------------------------
// Ortsdaten (wie PoiRepository.kt)
// ---------------------------------------------------------------------------
const NAMENS_SPALTE = { de: 8, fr: 9, it: 10, en: 11 };

function rang(typ, untertyp, name, hoehe) {
  switch (typ) {
    case "ORT": return untertyp === "city" ? 100 : untertyp === "town" ? 80 : 45;
    case "GIPFEL": return 35 + Math.min(Math.floor((hoehe || 0) / 50), 65);
    case "SEE": return 60;
    case "BURG": return /^ehem/i.test(name) ? 15 : untertyp === "castle" ? 55 : 45;
    case "AUSSICHT": return 30;
    default: return ["church", "chapel", "memorial", "wayside_shrine"].includes(untertyp) ? 35 : 50;
  }
}

async function orteLaden() {
  if (alleOrte) return alleOrte;
  const text = await (await fetch("pois.tsv")).text();
  const spalte = NAMENS_SPALTE[SPRACHE];
  alleOrte = [];
  for (const zeile of text.split("\n")) {
    if (!zeile || zeile[0] === "#") continue;
    const c = zeile.split("\t");
    if (c.length < 6 || !TYPEN[c[0]]) continue;
    const la = parseFloat(c[3]), lo = parseFloat(c[4]);
    if (isNaN(la) || isNaN(lo)) continue;
    const hoehe = parseInt(c[5]) || null;
    alleOrte.push({
      typ: c[0], untertyp: c[1], nameOriginal: c[2],
      name: (spalte && c[spalte] && c[spalte].trim()) || c[2],
      lat: la, lon: lo, hoehe,
      rang: rang(c[0], c[1], c[2], hoehe),
      wikipedia: c[6] || null, wikidata: (c[7] || "").trim() || null
    });
  }
  return alleOrte;
}

const FUELL = new Set(["ruine", "burgruine", "burg", "schloss", "ehem.", "aussichtspunkt", "aussicht"]);
const normalisieren = (n) => n.toLowerCase().split(/[ -]/).filter((w) => w && !FUELL.has(w))
  .join("").replace(/fluh/g, "flue").replace(/[^\p{L}]/gu, "");
const TYP_REIHENFOLGE = ["GIPFEL", "ORT", "BURG", "SEE", "AUSSICHT", "SEHENSWUERDIGKEIT"];

function zusammenfassen(liste) {
  const res = [], nachName = new Map();
  liste.slice().sort((a, b) => TYP_REIHENFOLGE.indexOf(a.typ) - TYP_REIHENFOLGE.indexOf(b.typ) || b.rang - a.rang)
    .forEach((p) => {
      const key = normalisieren(p.nameOriginal);
      const kand = nachName.get(key) || [];
      const i = key.length < 3 ? undefined :
        kand.find((j) => distanzKm(p.lat, p.lon, res[j].lat, res[j].lon) < 1);
      if (i === undefined) { res.push({ ...p }); kand.push(res.length - 1); nachName.set(key, kand); }
      else {
        const v = res[i];
        v.hoehe = v.hoehe ?? p.hoehe; v.rang = Math.max(v.rang, p.rang);
        v.wikipedia = v.wikipedia ?? p.wikipedia; v.wikidata = v.wikidata ?? p.wikidata;
      }
    });
  return res;
}

async function orteImUmkreis() {
  $("statusDaten").textContent = t("lade_orte");
  const alle = await orteLaden();
  const r = einst.radiusKm, dLat = r / 111, dLon = r / (111 * Math.cos(lat * RAD));
  const nah = alle.filter((p) => Math.abs(p.lat - lat) <= dLat && Math.abs(p.lon - lon) <= dLon &&
    distanzKm(lat, lon, p.lat, p.lon) <= r);
  pois = zusammenfassen(nah);
  ladenFuer = { lat, lon, r };
  $("statusDaten").textContent = pois.length ? t("orte_umkreis", pois.length, r) : t("keine_orte");
  const ort = naechsterOrt(lat, lon, 5);
  $("statusOrt").textContent = "📍 " + (ort ? ort.name : t("standort_suche"));
}

function naechsterOrt(la, lo, maxKm, bedingung = () => true) {
  let best = null, bestD = maxKm;
  for (const p of pois) {
    if (p.typ !== "ORT" || !bedingung(p)) continue;
    const d = distanzKm(la, lo, p.lat, p.lon);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Sensoren: Kamera, Standort, Kompass
// ---------------------------------------------------------------------------
async function starten() {
  // iOS verlangt die Erlaubnis für Bewegungssensoren direkt nach einem Tipp
  try {
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch { /* abgelehnt -> Hinweis erscheint später */ }

  $("start").classList.add("versteckt");
  $("kamera").classList.remove("versteckt");
  $("statusOrt").textContent = "📍 " + t("standort_suche");

  if (DEMO) { demoStarten(); }
  else {
    kameraStarten();
    standortStarten();
    kompassStarten();
  }
  requestAnimationFrame(zeichnen);
}

async function kameraStarten() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false
    });
    $("video").srcObject = stream;
  } catch (e) {
    warnung(t("berechtigung_fehlt"));
  }
}

function standortStarten() {
  if (!navigator.geolocation) { warnung(t("berechtigung_fehlt")); return; }
  navigator.geolocation.watchPosition((pos) => {
    lat = pos.coords.latitude; lon = pos.coords.longitude;
    // Orte neu berechnen, wenn man sich mehr als 500 m bewegt hat
    if (!ladenFuer || distanzKm(lat, lon, ladenFuer.lat, ladenFuer.lon) > 0.5) orteImUmkreis();
  }, () => warnung(t("berechtigung_fehlt")), { enableHighAccuracy: true, maximumAge: 10000 });
}

function kompassStarten() {
  let bekommen = false;
  const verarbeiten = (richtung) => {
    bekommen = true;
    const a = richtung * RAD;
    if (!kompassInit) { sinAvg = Math.sin(a); cosAvg = Math.cos(a); kompassInit = true; }
    else { sinAvg += 0.2 * (Math.sin(a) - sinAvg); cosAvg += 0.2 * (Math.cos(a) - cosAvg); }
    rohRichtung = ((Math.atan2(sinAvg, cosAvg) / RAD) + DEKLINATION + 360) % 360;
  };

  // iPhone: Safari liefert die Kompassrichtung direkt
  window.addEventListener("deviceorientation", (e) => {
    if (typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading)) {
      verarbeiten(e.webkitCompassHeading);
    }
  });
  // Android (Chrome): absolute Ausrichtung -> Richtung der Rückkamera berechnen
  window.addEventListener("deviceorientationabsolute", (e) => {
    if (e.alpha == null) return;
    verarbeiten(kameraRichtung(e.alpha, e.beta, e.gamma));
  });
  setTimeout(() => { if (!bekommen) warnung(t("kompass_warten")); }, 3000);
}

/** Richtung der Rückkamera aus alpha/beta/gamma (W3C DeviceOrientation, Erde: x=Ost, y=Nord) */
function kameraRichtung(alpha, beta, gamma) {
  const a = alpha * RAD, b = beta * RAD, g = gamma * RAD;
  // Rückkamera = -Z-Achse des Geräts in Erdkoordinaten
  const x = -(Math.cos(a) * Math.sin(g) + Math.sin(a) * Math.sin(b) * Math.cos(g));
  const y = -(Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.sin(b) * Math.cos(g));
  return (Math.atan2(x, y) / RAD + 360) % 360;
}

function warnung(text) {
  const w = $("statusWarnung");
  w.textContent = "⚠️ " + text;
  w.classList.remove("versteckt");
}

/** Demo-Modus für den PC: feste Position (Liestal), Richtung mit Maus/Pfeiltasten ändern */
function demoStarten() {
  lat = 47.4844; lon = 7.7349; rohRichtung = 90;
  $("kamera").style.background = "linear-gradient(#4A7290, #F2B880 60%, #233F59 60%)";
  orteImUmkreis();
  let startX = null;
  addEventListener("pointerdown", (e) => { if (e.target.id === "labels" || e.target.id === "video" || e.target.id === "kamera") startX = e.clientX; });
  addEventListener("pointermove", (e) => { if (startX != null) { rohRichtung = (rohRichtung - (e.clientX - startX) * 0.15 + 360) % 360; startX = e.clientX; } });
  addEventListener("pointerup", () => { startX = null; });
  addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") rohRichtung = (rohRichtung - 3 + 360) % 360;
    if (e.key === "ArrowRight") rohRichtung = (rohRichtung + 3) % 360;
  });
}

// ---------------------------------------------------------------------------
// Anzeige der Labels (wie ArOverlay.kt)
// ---------------------------------------------------------------------------
function blickrichtung() { return (rohRichtung + einst.korrektur + 720) % 360; }

function projektion() {
  const W = innerWidth, H = innerHeight;
  const s = Math.max(W / (2 * KAMERA_HALB_TAN_KURZ), H / (2 * KAMERA_HALB_TAN_LANG));
  return { W, H, s, halbWinkel: Math.atan(W / (2 * s)) / RAD };
}

function punkte(l) {
  const abzug = l.poi.typ === "GIPFEL" ? 1.0 : 2.5;
  return l.poi.rang - l.dist * abzug;
}

let letzteZeichnung = 0;
function zeichnen(zeit) {
  requestAnimationFrame(zeichnen);
  if (zeit - letzteZeichnung < 66) return;      // ca. 15 Bilder pro Sekunde reichen
  letzteZeichnung = zeit;
  if (lat == null || rohRichtung == null) return;

  const ausserhalb = !imDatengebiet(lat, lon) || (ladenFuer && pois.length === 0);
  $("ausserhalb").classList.toggle("versteckt", !ausserhalb);

  const { W, H, s, halbWinkel } = projektion();
  const blick = blickrichtung();
  const imBlickfeld = [];
  for (const p of pois) {
    if (!einst.kategorien.includes(p.typ)) continue;
    const dist = distanzKm(lat, lon, p.lat, p.lon);
    if ((p.typ === "ORT" && dist < 1) || dist < 0.05) continue;
    const winkel = ((richtungZu(lat, lon, p.lat, p.lon) - blick + 540) % 360) - 180;
    if (Math.abs(winkel) <= halbWinkel) imBlickfeld.push({ poi: p, dist, winkel });
  }

  // Fokus (Bildmitte) mit Haltezone
  if (!(fokus && imBlickfeld.some((l) => l.poi === fokus && Math.abs(l.winkel) <= FOKUS_HALTEN_GRAD))) {
    const kand = imBlickfeld.filter((l) => Math.abs(l.winkel) <= FOKUS_GRAD)
      .sort((a, b) => (punkte(b) - Math.abs(b.winkel) * 5) - (punkte(a) - Math.abs(a.winkel) * 5))[0];
    const neu = kand ? kand.poi : null;
    if (neu !== fokus) { fokus = neu; fokusKarte(); }
  }

  const auswahl = imBlickfeld.slice().sort((a, b) => punkte(b) - punkte(a)).slice(0, einst.maxLabels);
  if (fokus && !auswahl.some((l) => l.poi === fokus)) {
    const f = imBlickfeld.find((l) => l.poi === fokus); if (f) auswahl.push(f);
  }
  auswahl.sort((a, b) => a.dist - b.dist);

  // Zeilen zuteilen, damit sich Labels nicht überdecken
  const breite = 140, zeilenHoehe = 58, horizont = H * 0.6;
  const maxZeilen = Math.max(3, Math.floor((horizont - 150) / zeilenHoehe));
  const zeilen = [];
  // Zuerst alle Striche, dann alle Labels – so liegen die Striche HINTER den Labels
  let striche = "", html = "";
  for (const l of auswahl) {
    const x = W / 2 + s * Math.tan(l.winkel * RAD);
    const links = Math.min(Math.max(x - breite / 2, 0), W - breite), mitte = links + breite / 2;
    let z = zeilen.findIndex((r) => r.every((m) => Math.abs(m - mitte) >= breite + 4));
    if (z === -1) { if (zeilen.length >= maxZeilen) continue; zeilen.push([]); z = zeilen.length - 1; }
    zeilen[z].push(mitte);
    const stiel = 16 + zeilenHoehe * z, oben = horizont - stiel - 44;
    const istFokus = l.poi === fokus ? " fokus" : "";
    const idx = pois.indexOf(l.poi);
    striche += `<div class="stiel${istFokus}" style="left:${x - 1}px;top:${horizont - stiel}px;height:${stiel}px"></div>`;
    html += `<div class="label${istFokus}" data-i="${idx}" style="left:${links}px;top:${oben}px">` +
      `<div class="name">${TYPEN[l.poi.typ]} ${esc(l.poi.name)}</div>` +
      `<div class="info">${km(l.dist)}${l.poi.hoehe ? " · " + l.poi.hoehe + " m" : ""}</div></div>`;
  }
  $("labels").innerHTML = striche + html;

  $("statusKompass").textContent =
    `🧭 ${Math.round(blick)}° ${kurzRichtung(blick)}  ·  ${t("im_blickfeld", auswahl.length)}`;
  const filter = $("statusFilter");
  filter.classList.toggle("versteckt", einst.kategorien.length === ALLE_TYPEN.length);
  filter.textContent = t("filter_aktiv") + ": " + ALLE_TYPEN.filter((k) => einst.kategorien.includes(k)).map((k) => TYPEN[k]).join(" ");
}

// Labels werden laufend neu gezeichnet. Ein "click" bräuchte dasselbe Element beim
// Drücken und Loslassen – darum reagieren wir aufs Loslassen (pointerup).
let tippStart = null;
$("labels").addEventListener("pointerdown", (e) => { tippStart = { x: e.clientX, y: e.clientY }; });
$("labels").addEventListener("pointerup", (e) => {
  const kurz = tippStart && Math.hypot(e.clientX - tippStart.x, e.clientY - tippStart.y) < 15;
  tippStart = null;
  const el = e.target.closest(".label");
  if (el && kurz) infoFenster(pois[+el.dataset.i]);
});

// ---------------------------------------------------------------------------
// Texte zu einem Ort: Art, Steckbrief, Wikipedia (wie Steckbrief.kt / WikipediaInfo.kt)
// ---------------------------------------------------------------------------
function artText(p) {
  const u = p.untertyp;
  switch (p.typ) {
    case "GIPFEL": return t("art_gipfel");
    case "ORT": return t(u === "city" ? "art_stadt" : u === "town" ? "art_kleinstadt" : "art_dorf");
    case "BURG": return t(u === "ruins" ? "art_burgruine" : "art_burg");
    case "SEE": return t("art_see");
    case "AUSSICHT": return t("art_aussicht");
    default: return t({ museum: "art_museum", monument: "art_denkmal", memorial: "art_gedenkstaette",
      church: "art_kirche", chapel: "art_kapelle", monastery: "art_kloster", tower: "art_turm",
      archaeological_site: "art_ausgrabung" }[u] || "art_sehenswuerdigkeit");
  }
}

function steckbrief(p) {
  const saetze = [p.hoehe ? t("steck_art_hoehe", artText(p), p.hoehe) : t("steck_art", artText(p))];
  let lage = t("steck_lage", km(distanzKm(lat, lon, p.lat, p.lon)), langRichtung(richtungZu(lat, lon, p.lat, p.lon)));
  let nachsatz = null;
  const bezug = p.typ === "ORT"
    ? naechsterOrt(p.lat, p.lon, 999, (o) => o.nameOriginal !== p.nameOriginal && (o.untertyp === "town" || o.untertyp === "city"))
    : naechsterOrt(p.lat, p.lon, 10, (o) => o.nameOriginal !== p.nameOriginal);
  if (bezug) {
    const d = distanzKm(bezug.lat, bezug.lon, p.lat, p.lon);
    if (p.typ === "ORT") nachsatz = t("steck_naechste_stadt", bezug.name, km(d));
    else if (d < 0.4) lage += t("steck_im_ort", bezug.name);
    else lage += t("steck_von_ort", km(d), langRichtung(richtungZu(bezug.lat, bezug.lon, p.lat, p.lon)), bezug.name);
  }
  saetze.push(lage + ".");
  if (nachsatz) saetze.push(nachsatz);
  if (p.typ === "GIPFEL" && p.hoehe && !pois.some((o) => o !== p && o.typ === "GIPFEL" &&
      (o.hoehe || 0) > p.hoehe && distanzKm(o.lat, o.lon, p.lat, p.lon) < 3)) {
    saetze.push(t("steck_hoechster"));
  }
  return saetze.join(" ");
}

const wikiCache = new Map();
const SPRACHEN = [...new Set([SPRACHE, "de", "en", "fr", "it"])];

async function json(url) {
  const r = await fetch(url);
  if (r.status === 404) return {};
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

/** Wikipedia -> Wikidata-Kurzbeschreibung -> Artikel in der Nähe */
async function onlineInfo(p) {
  const key = p.nameOriginal + p.lat + p.lon;
  if (wikiCache.has(key)) return wikiCache.get(key);
  const info = { wiki: null, kurz: null, naehe: [], fehler: false };
  try {
    let artikel = null;
    if (p.wikidata) {
      const d = await json(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(p.wikidata)}` +
        `&props=sitelinks%7Cdescriptions&languages=${SPRACHEN.join("%7C")}&format=json&origin=*`);
      const e = d.entities && d.entities[p.wikidata];
      if (e) {
        for (const s of SPRACHEN) {
          const sl = e.sitelinks && e.sitelinks[s + "wiki"];
          if (sl && !artikel) artikel = [s, sl.title];
          const de = e.descriptions && e.descriptions[s];
          if (de && !info.kurz) info.kurz = de.value;
        }
      }
    }
    if (!artikel && p.wikipedia && /^[a-z]{2,3}:/.test(p.wikipedia)) {
      const i = p.wikipedia.indexOf(":"); artikel = [p.wikipedia.slice(0, i), p.wikipedia.slice(i + 1)];
    }
    if (artikel) {
      const [s, titel] = artikel;
      const d = await json(`https://${s}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titel.replace(/ /g, "_"))}`);
      if (d.extract) info.wiki = { titel: d.title || titel, text: d.extract,
        url: (d.content_urls && d.content_urls.mobile && d.content_urls.mobile.page) || `https://${s}.m.wikipedia.org/wiki/${encodeURIComponent(titel)}` };
    }
    if (!info.wiki) {
      const s = ["de", "fr", "it", "en"].includes(SPRACHE) ? SPRACHE : "de";
      const d = await json(`https://${s}.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${p.lat}%7C${p.lon}` +
        `&gsradius=3000&gslimit=6&format=json&origin=*`);
      info.naehe = ((d.query && d.query.geosearch) || [])
        .filter((a) => a.title.toLowerCase() !== p.name.toLowerCase()).slice(0, 4)
        .map((a) => ({ titel: a.title, dist: a.dist, url: `https://${s}.m.wikipedia.org/wiki/${encodeURIComponent(a.title.replace(/ /g, "_"))}` }));
    }
    wikiCache.set(key, info);
  } catch { info.fehler = true; }
  return info;
}

// ---------------------------------------------------------------------------
// Info-Karte unten ("Du schaust auf")
// ---------------------------------------------------------------------------
let fokusTimer = null;
function fokusKarte() {
  const box = $("fokus");
  clearTimeout(fokusTimer);
  if (!fokus) { box.classList.add("versteckt"); return; }
  const p = fokus;
  const kopf = `<div class="ueber">${t("fokus_du_schaust_auf")}</div>` +
    `<div class="titel">${TYPEN[p.typ]} ${esc(p.name)}</div>` +
    `<div class="art">${artText(p)}${p.hoehe ? " · " + p.hoehe + " m" : ""} · ${km(distanzKm(lat, lon, p.lat, p.lon))}</div>`;
  const fuss = (quelle) => `<div class="quelle">${quelle}</div><div class="mehr">${t("fokus_mehr")}</div>`;
  box.innerHTML = kopf + `<div class="text">${esc(steckbrief(p))}</div>` + fuss(t("quelle_osm"));
  box.classList.remove("versteckt");
  box.onclick = () => infoFenster(p);
  fokusTimer = setTimeout(async () => {
    const info = await onlineInfo(p);
    if (fokus !== p) return;
    if (info.wiki) box.innerHTML = kopf + `<div class="text">${esc(info.wiki.text)}</div>` + fuss(t("quelle_wikipedia"));
    else if (info.kurz) box.innerHTML = kopf + `<div class="text">${esc(info.kurz[0].toUpperCase() + info.kurz.slice(1))}. ${esc(steckbrief(p))}</div>` + fuss(t("quelle_wikidata"));
  }, 600);
}

// ---------------------------------------------------------------------------
// Fenster: Info, Einstellungen, Über
// ---------------------------------------------------------------------------
function sheetOeffnen(html) {
  $("sheetInhalt").innerHTML = html;
  $("sheet").scrollTop = 0;
  $("sheet").classList.remove("versteckt");
  $("sheetHintergrund").classList.remove("versteckt");
}
function sheetSchliessen() {
  $("sheet").classList.add("versteckt");
  $("sheetHintergrund").classList.add("versteckt");
}
$("sheetHintergrund").addEventListener("click", sheetSchliessen);

async function infoFenster(p) {
  const dist = distanzKm(lat, lon, p.lat, p.lon), r = richtungZu(lat, lon, p.lat, p.lon);
  const route = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
  const karte = `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=14/${p.lat}/${p.lon}`;
  const basis = `<h2>${TYPEN[p.typ]} ${esc(p.name)}</h2>` +
    `<p class="leise">${artText(p)}${p.hoehe ? " · " + t("hoehe", p.hoehe) : ""}</p>` +
    `<p>${t("entfernung_richtung", zahl(dist), Math.round(r), kurzRichtung(r))}</p>`;
  const steck = `<h3>${t("info_steckbrief")}</h3><p>${esc(steckbrief(p))}</p><p class="quelle">${t("quelle_kartendaten")}</p>`;
  const knoepfe = `<a class="knopf" href="${route}" target="_blank" rel="noopener">${t("info_route")}</a>` +
    `<a class="knopf-rand" href="${karte}" target="_blank" rel="noopener">${t("info_karte")}</a>` +
    `<p class="leise" style="margin-top:16px">${t("info_kompass_hilfe")}</p>` +
    `<button class="text-knopf" id="ausrichten">${t("info_kompass_ausrichten")}</button>`;

  const zeigen = (mitte) => {
    sheetOeffnen(basis + mitte + knoepfe);
    $("ausrichten").onclick = () => {
      let k = (r - rohRichtung) % 360;
      if (k > 180) k -= 360; if (k < -180) k += 360;
      einst.korrektur = k; einstSpeichern(); sheetSchliessen();
    };
  };
  zeigen(steck + `<p class="leise">${t("info_suche_online")}</p>`);

  const info = await onlineInfo(p);
  let oben = "", unten = "";
  if (info.wiki) {
    oben = `<h3>Wikipedia</h3><p>${esc(info.wiki.text)}</p>` +
      `<p class="quelle"><a href="${info.wiki.url}" target="_blank" rel="noopener">${esc(t("info_wiki_quelle", info.wiki.titel))}</a></p>`;
  } else if (info.kurz) {
    oben = `<h3>${t("info_kurzbeschreibung")}</h3><p>${esc(info.kurz[0].toUpperCase() + info.kurz.slice(1))}.</p><p class="quelle">${t("quelle_wikidata")}</p>`;
  }
  if (info.fehler) unten = `<p class="leise">${t("info_offline")}</p>`;
  else if (info.naehe.length) unten = `<h3>${t("info_in_der_naehe")}</h3><div class="naehe">` +
    info.naehe.map((a) => `<a href="${a.url}" target="_blank" rel="noopener">📖 ${esc(a.titel)} · ${km(a.dist / 1000)}</a>`).join("") + "</div>";
  if (!$("sheet").classList.contains("versteckt")) zeigen(oben + steck + unten);
}

function einstellungenFenster() {
  const chips = ALLE_TYPEN.map((k) =>
    `<button class="chip${einst.kategorien.includes(k) ? " an" : ""}" data-k="${k}">${TYPEN[k]} ${t("kat_" + k)}</button>`).join("");
  const korr = einst.korrektur
    ? `<p class="leise">${t("einst_kompass_wert", (einst.korrektur > 0 ? "+" : "") + Math.round(einst.korrektur))}</p>` +
      `<button class="knopf-rand" id="korrWeg">${t("einst_kompass_zuruecksetzen")}</button>`
    : `<p class="leise">${t("einst_kompass_keine")}</p>`;
  sheetOeffnen(
    `<h2>${t("einst_titel")}</h2>` +
    `<div class="zeile"><h3>${t("einst_anzeigen")}</h3>` +
    (einst.kategorien.length < ALLE_TYPEN.length ? `<button class="text-knopf" id="alle">${t("einst_alle")}</button>` : "") +
    `</div><div class="chips">${chips}</div>` +
    `<h3 id="radiusText">${t("einst_umkreis", einst.radiusKm)}</h3>` +
    `<input type="range" id="radius" min="5" max="100" value="${einst.radiusKm}">` +
    `<h3 id="labelsText">${t("einst_labels", einst.maxLabels)}</h3>` +
    `<input type="range" id="maxLabels" min="3" max="25" value="${einst.maxLabels}">` +
    `<h3>${t("einst_kompass")}</h3>${korr}` +
    `<p><button class="text-knopf" id="ueberLink">${t("start_rechtliches")} ›</button></p>`);

  document.querySelectorAll(".chip").forEach((c) => c.onclick = () => {
    const k = c.dataset.k, an = einst.kategorien.includes(k);
    const neu = an ? einst.kategorien.filter((x) => x !== k) : [...einst.kategorien, k];
    if (neu.length) { einst.kategorien = neu; einstSpeichern(); einstellungenFenster(); }
  });
  const alle = $("alle"); if (alle) alle.onclick = () => { einst.kategorien = ALLE_TYPEN; einstSpeichern(); einstellungenFenster(); };
  $("radius").oninput = (e) => { $("radiusText").textContent = t("einst_umkreis", e.target.value); };
  $("radius").onchange = (e) => { einst.radiusKm = +e.target.value; einstSpeichern(); if (lat != null) orteImUmkreis(); };
  $("maxLabels").oninput = (e) => {
    einst.maxLabels = +e.target.value; einstSpeichern();
    $("labelsText").textContent = t("einst_labels", einst.maxLabels);
  };
  const kw = $("korrWeg"); if (kw) kw.onclick = () => { einst.korrektur = 0; einstSpeichern(); einstellungenFenster(); };
  $("ueberLink").onclick = ueberFenster;
}

function ueberFenster() {
  sheetOeffnen(`<h2>${t("ueber_titel")}</h2><p class="rechtstext">${esc(t("ueber_text"))}</p>` +
    `<p><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">openstreetmap.org/copyright</a></p>` +
    `<p><a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a></p>`);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
document.documentElement.lang = SPRACHE;
document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t(el.dataset.t); });
$("startKnopf").onclick = starten;
$("startInfo").onclick = ueberFenster;
$("einstellungenKnopf").onclick = einstellungenFenster;
$("statusFilter").onclick = einstellungenFenster;
