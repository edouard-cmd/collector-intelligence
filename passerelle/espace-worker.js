/* Le Collectionnaire, espace collectionneur : la passerelle sécurisée.

   Ce worker Cloudflare fait trois choses, et rien d'autre :

   1. Il ouvre la porte. La connexion passe par le compte Google de la collectionneuse
      (SSO). Le jeton signé par Google est vérifié ici, avec les clés publiques de Google,
      puis l'adresse est comparée à la liste AUTORISES. Personne d'autre n'entre, même
      avec un compte Google valide. Aucun mot de passe n'est stocké nulle part.

   2. Il garde la collection. Objets, photos, relevés de cote, ventes conclues et lots
      d'enchères suivis vivent dans une base D1 (SQLite chez Cloudflare), rangés par
      adresse e-mail. La règle du format pivot vaut ici aussi : une vente sans url_source
      n'entre pas dans la base.

   3. Il suit les enchères. Chaque matin (déclencheur Cron), il relit les pages des lots
      dont la vente est passée et relève le résultat. L'IA lit la page et dit où est le
      prix ; le code vérifie que ce chiffre est écrit tel quel sur la page avant de
      l'enregistrer. Un chiffre que la page ne porte pas n'entre jamais.

   4. Il veille (bloc 3 du devis). Chaque matin, pour chaque objet de la collection, il
      cherche les nouvelles ventes conclues avec la signature de veille de l'objet (termes,
      exclusions, fourchette), garde celles dont l'adresse a été réellement consultée et dont
      le prix est écrit sur la page, et les rattache à l'objet. Voyants de santé dans
      l'interface ; e-mail au prestataire après trois jours d'échec consécutifs.

   5. Il cote et il prévient (blocs 4 et 5). La cote est calculée par le code sur les seules
      ventes conclues des douze derniers mois, à partir de trois ventes, sinon l'objet est
      « non cotable ». Moyenne, médiane, volatilité, tendance et projection sont des calculs,
      jamais des chiffres produits par l'IA. Une vente qui sort du rythme habituel de l'objet
      déclenche le moteur d'explication (trois hypothèses au plus, avec leur confiance) et un
      e-mail ; les paliers +50 %, +100 % et -25 % sur le prix payé aussi.

   Réglages, tous dans le tableau de bord Cloudflare (aucun Terminal) :
     BASE               liaison D1, la base de la collection
     GOOGLE_CLIENT_ID   variable, identifiant client OAuth créé dans Google Cloud
     AUTORISES          variable, adresses autorisées séparées par des virgules
                        (une entrée "@domaine.fr" ouvre tout un domaine)
     ORIGINES           variable, adresses des pages autorisées à appeler le worker
     SESSION_SECRET     secret, longue chaîne aléatoire qui signe les sessions
     ANTHROPIC_API_KEY  secret, clé de l'API Anthropic
     MODELE_LECTURE     variable facultative, modèle qui lit les pages de lots
     LIMITE_TOURNEE     variable facultative, nombre maximal de lots relus par matin
     BREVO_API_KEY      secret facultatif, clé de l'API d'envoi d'e-mails Brevo
     EMAIL_EXPEDITEUR   variable facultative, adresse expéditrice validée chez Brevo
     EMAIL_PRESTATAIRE  variable facultative, adresse prévenue si la collecte échoue 3 jours
     URL_ESPACE         variable facultative, adresse de la page espace.html (lien des e-mails)
     MODELE_VEILLE      variable facultative, modèle de la veille quotidienne
     MODELE_EXPLICATION variable facultative, modèle du moteur d'explication
     LIMITE_VEILLE      variable facultative, nombre maximal d'objets surveillés par matin
     RECHERCHES_VEILLE  variable facultative, recherches web par objet et par matin

   Aucune place de marché n'est nommée dans ce code : la lecture d'un lot est générique,
   comme le reste du moteur. */

const VERSION = "espace-2.0";
const DUREE_SESSION = 7 * 24 * 3600;              // une semaine, puis reconnexion
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISS = ["accounts.google.com", "https://accounts.google.com"];
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const MODELE_LECTURE = "claude-haiku-4-5-20251001";
const MODELE_VEILLE = "claude-haiku-4-5-20251001";
const MODELE_EXPLICATION = "claude-sonnet-5";
const URL_ESPACE = "https://edouard-cmd.github.io/collector-intelligence/docs/espace.html";
const RYTHMES = { quotidienne: 1, hebdomadaire: 7, mensuelle: 30 };   // en jours ; « arretee » coupe la veille
const JOURS_ATTENTE_RESULTAT = 21;                // au-delà, on arrête de relire seul
const ID = /^[A-Za-z0-9_-]{6,64}$/;

/* ---------- la base ---------- */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS utilisateurs (email TEXT PRIMARY KEY, nom TEXT, photo TEXT,
     fournisseur TEXT, cree_le TEXT, vu_le TEXT)`,
  `CREATE TABLE IF NOT EXISTS objets (id TEXT PRIMARY KEY, email TEXT NOT NULL,
     donnees TEXT NOT NULL, cree_le TEXT, maj_le TEXT)`,
  `CREATE INDEX IF NOT EXISTS objets_email ON objets(email)`,
  `CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, objet_id TEXT NOT NULL, email TEXT NOT NULL,
     rang INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, maj_le TEXT)`,
  `CREATE INDEX IF NOT EXISTS photos_objet ON photos(objet_id, rang)`,
  `CREATE TABLE IF NOT EXISTS releves (id TEXT PRIMARY KEY, email TEXT NOT NULL,
     objet_id TEXT NOT NULL, date TEXT, base TEXT, nature TEXT, n INTEGER, mediane REAL,
     q1 REAL, q3 REAL, min REAL, max REAL, devise TEXT, confiance TEXT, source TEXT, cree_le TEXT)`,
  `CREATE INDEX IF NOT EXISTS releves_email ON releves(email, objet_id)`,
  `CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, email TEXT NOT NULL,
     objet_id TEXT, prix REAL NOT NULL, devise TEXT NOT NULL, date TEXT, plateforme TEXT,
     url_source TEXT NOT NULL, cle TEXT NOT NULL, libelle TEXT, correspondance TEXT,
     origine TEXT, preuve TEXT, frais_inclus INTEGER, lot_id TEXT, verifie INTEGER, cree_le TEXT,
     UNIQUE(email, cle))`,
  `CREATE INDEX IF NOT EXISTS transactions_email ON transactions(email, objet_id)`,
  `CREATE TABLE IF NOT EXISTS lots (id TEXT PRIMARY KEY, email TEXT NOT NULL, objet_id TEXT,
     url TEXT NOT NULL, cle TEXT NOT NULL, maison TEXT, titre TEXT, date_vente TEXT,
     estimation_basse REAL, estimation_haute REAL, enchere_actuelle REAL, devise TEXT,
     statut TEXT, prix_adjuge REAL, frais_inclus INTEGER, extrait TEXT, provenance TEXT,
     note TEXT, tentatives INTEGER DEFAULT 0, derniere_lecture TEXT, cree_le TEXT,
     maj_le TEXT, UNIQUE(email, cle))`,
  `CREATE INDEX IF NOT EXISTS lots_statut ON lots(statut, date_vente)`,
  `CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT,
     date TEXT, type TEXT, message TEXT, objet_id TEXT, lot_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS journal_email ON journal(email, id)`,
  `CREATE TABLE IF NOT EXISTS veille (objet_id TEXT PRIMARY KEY, email TEXT NOT NULL, derniere_veille TEXT,
     derniere_reussite TEXT, echecs INTEGER DEFAULT 0, bilan TEXT, palier TEXT, cote TEXT, maj_le TEXT)`,
  `CREATE TABLE IF NOT EXISTS anomalies (id TEXT PRIMARY KEY, email TEXT NOT NULL, objet_id TEXT, date TEXT,
     type TEXT, ampleur REAL, message TEXT, transaction_id TEXT, explication TEXT, notifie INTEGER DEFAULT 0,
     cree_le TEXT)`,
  `CREATE INDEX IF NOT EXISTS anomalies_email ON anomalies(email, date)`,
  `CREATE TABLE IF NOT EXISTS sante (jour TEXT PRIMARY KEY, essais INTEGER DEFAULT 0, reussites INTEGER DEFAULT 0,
     nouvelles INTEGER DEFAULT 0, alerte_envoyee INTEGER DEFAULT 0, maj_le TEXT)`,
  `CREATE TABLE IF NOT EXISTS credits (email TEXT PRIMARY KEY, solde INTEGER NOT NULL DEFAULT 0, cree_le TEXT)`,
  `CREATE TABLE IF NOT EXISTS mouvements_credits (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL,
     date TEXT, delta INTEGER NOT NULL, solde INTEGER, motif TEXT, ref TEXT UNIQUE)`,
  `CREATE INDEX IF NOT EXISTS mouvements_credits_email ON mouvements_credits(email, id)`,
];

let basePrete = null;
async function base(env) {
  if (!env.BASE) throw new Erreur(503, "base D1 non reliée au worker (liaison BASE absente)");
  if (!basePrete) basePrete = env.BASE.batch(SCHEMA.map(s => env.BASE.prepare(s)))
    .catch(e => { basePrete = null; throw e; });
  await basePrete;
  return env.BASE;
}

/* ---------- outils ---------- */

class Erreur extends Error {
  constructor(statut, message) { super(message); this.statut = statut; }
}

const maintenant = () => new Date().toISOString();
const aujourdhui = () => maintenant().slice(0, 10);
const nouvelId = () => crypto.randomUUID();
const enc = new TextEncoder();

function b64url(octets) {
  let s = "";
  new Uint8Array(octets).forEach(o => s += String.fromCharCode(o));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function octetsB64(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
const texteB64 = s => new TextDecoder().decode(octetsB64(s));

/* Une adresse de page ramenée à sa forme stable : c'est la clé de déduplication, comme
   dans le format pivot du moteur Python. Deux liens vers la même fiche ne font qu'une vente. */
function cleUrl(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch { return null; }
}
function urlValide(u) {
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:"; }
  catch { return false; }
}
const domaine = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const nombre = v => (v === null || v === undefined || v === "" || isNaN(+v)) ? null : +v;
const devise = v => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v)) ? v.toUpperCase() : null;
const date10 = v => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) ? v.slice(0, 10) : null;
const court = (v, n = 300) => typeof v === "string" ? v.slice(0, n) : null;

function listeEnv(v) {
  return (v || "").split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
}

/* ---------- les en-têtes CORS ---------- */

function enTetesCors(req, env) {
  const origine = req.headers.get("Origin");
  const h = { "Vary": "Origin" };
  if (origine && listeEnv(env.ORIGINES).includes(origine.toLowerCase())) {
    h["Access-Control-Allow-Origin"] = origine;
    h["Access-Control-Allow-Headers"] = "authorization, content-type";
    h["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}
function origineRefusee(req, env) {
  const origine = req.headers.get("Origin");
  return origine && !listeEnv(env.ORIGINES).includes(origine.toLowerCase());
}

const json = (corps, statut, cors) => new Response(JSON.stringify(corps), {
  status: statut || 200,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors }
});

/* ---------- 1. la porte : SSO Google puis session signée ---------- */

let clesGoogle = null;
async function lireClesGoogle(env, forcer) {
  const url = env.GOOGLE_JWKS_URL || GOOGLE_JWKS;   // GOOGLE_JWKS_URL ne sert qu'aux tests
  if (!forcer && clesGoogle && clesGoogle.url === url && clesGoogle.fin > Date.now()) return clesGoogle.cles;
  const r = await fetch(url);
  if (!r.ok) throw new Erreur(503, "clés publiques de Google injoignables, réessayer dans un instant");
  const j = await r.json();
  const age = +(/max-age=(\d+)/.exec(r.headers.get("cache-control") || "") || [])[1] || 3600;
  clesGoogle = { url, cles: j.keys || [], fin: Date.now() + Math.min(age, 21600) * 1000 };
  return clesGoogle.cles;
}

/* Le jeton d'identité est signé par Google (RS256). On vérifie la signature avec la clé
   publique annoncée par Google, puis l'émetteur, le destinataire (notre identifiant
   client), l'expiration et l'adresse vérifiée. Un seul de ces contrôles qui échoue, et
   la porte reste fermée. */
async function verifierJetonGoogle(credential, env) {
  if (!env.GOOGLE_CLIENT_ID) throw new Erreur(503, "GOOGLE_CLIENT_ID absent des réglages du worker");
  const morceaux = String(credential || "").split(".");
  if (morceaux.length !== 3) throw new Erreur(401, "jeton Google mal formé");
  let entete, charge;
  try { entete = JSON.parse(texteB64(morceaux[0])); charge = JSON.parse(texteB64(morceaux[1])); }
  catch { throw new Erreur(401, "jeton Google illisible"); }
  if (entete.alg !== "RS256") throw new Erreur(401, "algorithme de signature inattendu");

  let cles = await lireClesGoogle(env);
  let jwk = cles.find(k => k.kid === entete.kid);
  if (!jwk) { cles = await lireClesGoogle(env, true); jwk = cles.find(k => k.kid === entete.kid); }
  if (!jwk) throw new Erreur(401, "clé de signature inconnue");

  const cle = await crypto.subtle.importKey("jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const bonne = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cle, octetsB64(morceaux[2]),
    enc.encode(morceaux[0] + "." + morceaux[1]));
  if (!bonne) throw new Erreur(401, "signature Google invalide");

  const t = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(charge.aud) ? charge.aud : [charge.aud];
  if (!GOOGLE_ISS.includes(charge.iss)) throw new Erreur(401, "jeton émis par un autre service que Google");
  if (!aud.includes(env.GOOGLE_CLIENT_ID)) throw new Erreur(401, "jeton destiné à une autre application");
  if (!charge.exp || charge.exp < t - 60) throw new Erreur(401, "jeton Google expiré, se reconnecter");
  if (charge.iat && charge.iat > t + 300) throw new Erreur(401, "jeton Google daté du futur");
  if (!charge.email || !(charge.email_verified === true || charge.email_verified === "true"))
    throw new Erreur(401, "adresse e-mail non vérifiée par Google");
  return { email: charge.email.toLowerCase(), nom: charge.name || "", photo: charge.picture || "" };
}

function estAutorise(email, env) {
  const liste = listeEnv(env.AUTORISES);
  if (!liste.length) throw new Erreur(403, "aucune adresse autorisée : renseigner AUTORISES dans le worker");
  return liste.some(a => a.startsWith("@") ? email.endsWith(a) : email === a);
}

async function signer(texte, env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 24)
    throw new Erreur(503, "SESSION_SECRET absent ou trop court (24 caractères minimum)");
  const cle = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", cle, enc.encode(texte)));
}

async function creerSession(u, env) {
  const charge = b64url(enc.encode(JSON.stringify({
    e: u.email, n: u.nom, x: Math.floor(Date.now() / 1000) + DUREE_SESSION, v: 1 })));
  return charge + "." + await signer(charge, env);
}

/* Comparaison en temps constant : on ne laisse pas deviner une signature octet par octet. */
function egal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function lireSession(req, env) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("Authorization") || "");
  if (!m) throw new Erreur(401, "connexion requise");
  const [charge, sig] = m[1].split(".");
  if (!charge || !sig || !egal(sig, await signer(charge, env))) throw new Erreur(401, "session invalide, se reconnecter");
  let s;
  try { s = JSON.parse(texteB64(charge)); } catch { throw new Erreur(401, "session illisible"); }
  if (!s.x || s.x < Math.floor(Date.now() / 1000)) throw new Erreur(401, "session expirée, se reconnecter");
  // retirer une adresse de AUTORISES ferme la porte tout de suite, même avec une session ouverte
  if (!estAutorise(s.e, env)) throw new Erreur(403, "cette adresse n'est plus autorisée");
  return { email: s.e, nom: s.n };
}

/* ---------- 2. la collection ---------- */

async function lireEspace(u, env) {
  const db = await base(env);
  const [objets, releves, transactions, lots, journal, moi, veille, anomalies, sante] = await db.batch([
    db.prepare(`SELECT o.id, o.donnees, o.cree_le, o.maj_le,
                  (SELECT COUNT(*) FROM photos p WHERE p.objet_id = o.id AND p.email = o.email) AS nb_photos
                FROM objets o WHERE o.email = ? ORDER BY o.cree_le`).bind(u.email),
    db.prepare(`SELECT * FROM releves WHERE email = ? ORDER BY date, cree_le`).bind(u.email),
    db.prepare(`SELECT * FROM transactions WHERE email = ? ORDER BY date, cree_le`).bind(u.email),
    db.prepare(`SELECT * FROM lots WHERE email = ? ORDER BY date_vente, cree_le`).bind(u.email),
    db.prepare(`SELECT * FROM journal WHERE email = ? ORDER BY id DESC LIMIT 40`).bind(u.email),
    db.prepare(`SELECT email, nom, photo FROM utilisateurs WHERE email = ?`).bind(u.email),
    db.prepare(`SELECT objet_id, derniere_veille, derniere_reussite, echecs, bilan, palier FROM veille WHERE email = ?`).bind(u.email),
    db.prepare(`SELECT * FROM anomalies WHERE email = ? ORDER BY date DESC LIMIT 60`).bind(u.email),
    db.prepare(`SELECT * FROM sante ORDER BY jour DESC LIMIT 14`),
  ]);
  // la cote est recalculée à chaque lecture, sur les ventes stockées : une seule source de vérité
  const cotes = {};
  objets.results.forEach(o => { cotes[o.id] = calculerCote(transactions.results.filter(t => t.objet_id === o.id)); });
  return {
    utilisateur: moi.results[0] || { email: u.email, nom: u.nom },
    objets: objets.results.map(o => ({ ...o, donnees: JSON.parse(o.donnees), a_photo: o.nb_photos > 0 })),
    releves: releves.results,
    transactions: transactions.results,
    lots: lots.results,
    journal: journal.results,
    cotes,
    veille: Object.fromEntries(veille.results.map(v => [v.objet_id, { ...v, bilan: lireJSONsur(v.bilan) }])),
    anomalies: anomalies.results.map(a => ({ ...a, explication: lireJSONsur(a.explication) })),
    sante: sante.results,
    config: { email: !!(env.BREVO_API_KEY && env.EMAIL_EXPEDITEUR), rythmes: Object.keys(RYTHMES) },
    credits: await lireCredits(db, u, env),
    version: VERSION,
  };
}

async function noter(db, email, type, message, objet_id, lot_id) {
  await db.prepare(`INSERT INTO journal (email, date, type, message, objet_id, lot_id)
                    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(email, maintenant(), type, message, objet_id || null, lot_id || null).run();
}

/* ---------- les crédits ----------
   Une recherche lancée coûte un crédit, la recherche approfondie deux ; l'avis de l'expert et la
   veille du matin sont inclus. Le solde vit ici, dans la base : une page ne peut pas se créditer
   elle-même. Un crédit n'est retiré qu'une fois la recherche réussie : un échec ne coûte rien.
   Les packs se vendent par des liens de paiement Stripe (variables STRIPE_LIEN_DECOUVERTE, ...) ;
   le webhook /stripe crédite le compte quand le paiement est confirmé, une seule fois par paiement. */
const TARIFS = { identification: 1, marche: 1, marche_approfondi: 2, histoire: 1, avis: 0,
                 veille: 1, encheres: 1, encheres_approfondie: 2 };
const LIB_TARIF = { identification: "identification d'un objet", marche: "recherche des prix",
  marche_approfondi: "recherche des prix approfondie", histoire: "histoire du modèle", avis: "avis de l'expert",
  veille: "veille lancée à la main", encheres: "recherche d'enchères", encheres_approfondie: "recherche d'enchères approfondie" };
const PACKS = {
  decouverte:     { nom: "Découverte",     credits: 20,  offerts: 0,  prix: 9 },
  collectionneur: { nom: "Collectionneur", credits: 50,  offerts: 10, prix: 19 },
  passion:        { nom: "Passion",        credits: 120, offerts: 30, prix: 39 },
};
const creditsBienvenue = env => env.CREDITS_BIENVENUE !== undefined && env.CREDITS_BIENVENUE !== "" &&
  Number.isFinite(+env.CREDITS_BIENVENUE) ? Math.max(0, Math.round(+env.CREDITS_BIENVENUE)) : 10;
const estAdmin = (email, env) => { const e = String(email || "").toLowerCase();
  return listeEnv(env.ADMINS).some(a => a.startsWith("@") ? e.endsWith(a) : a === e); };
const plCredits = n => `${n} crédit${Math.abs(n) > 1 ? "s" : ""}`;

async function soldeDe(db, email, env) {
  const c = await db.prepare(`SELECT solde FROM credits WHERE email = ?`).bind(email).first();
  if (c) return c.solde;
  const b = creditsBienvenue(env), t = maintenant();
  const r = await db.prepare(`INSERT OR IGNORE INTO credits (email, solde, cree_le) VALUES (?, ?, ?)`).bind(email, b, t).run();
  if (r.meta?.changes && b) await db.prepare(`INSERT INTO mouvements_credits (email, date, delta, solde, motif) VALUES (?, ?, ?, ?, ?)`)
    .bind(email, t, b, b, `${plCredits(b)} offerts à l'ouverture de ton espace`).run();
  return (await db.prepare(`SELECT solde FROM credits WHERE email = ?`).bind(email).first()).solde;
}

async function lireCredits(db, u, env) {
  const solde = await soldeDe(db, u.email, env);
  const m = await db.prepare(`SELECT date, delta, solde, motif FROM mouvements_credits WHERE email = ? ORDER BY id DESC LIMIT 40`)
    .bind(u.email).all();
  const packs = Object.fromEntries(Object.entries(PACKS).map(([k, p]) =>
    [k, { ...p, lien: /^https:\/\/(buy|checkout)\.stripe\.com\//.test(env[`STRIPE_LIEN_${k.toUpperCase()}`] || "")
      ? env[`STRIPE_LIEN_${k.toUpperCase()}`] : null }]));
  return { solde, mouvements: m.results, tarifs: TARIFS, packs, admin: estAdmin(u.email, env) };
}

async function debiterCredits(db, email, action, env, detail) {
  if (!Object.prototype.hasOwnProperty.call(TARIFS, action)) throw new Erreur(400, "action inconnue");
  const cout = TARIFS[action];
  const avant = await soldeDe(db, email, env);
  if (!cout) return { solde: avant, cout: 0 };
  const r = await db.prepare(`UPDATE credits SET solde = solde - ? WHERE email = ? AND solde >= ?`).bind(cout, email, cout).run();
  if (!r.meta?.changes) throw new Erreur(402, avant ? `il te reste ${plCredits(avant)}, il en faut ${cout}` : "tu n'as plus de crédits");
  const solde = (await db.prepare(`SELECT solde FROM credits WHERE email = ?`).bind(email).first()).solde;
  await db.prepare(`INSERT INTO mouvements_credits (email, date, delta, solde, motif) VALUES (?, ?, ?, ?, ?)`)
    .bind(email, maintenant(), -cout, solde, LIB_TARIF[action] + (detail ? `, ${court(String(detail), 80)}` : "")).run();
  return { solde, cout };
}

// le solde avant l'action : on ne lance pas une recherche qu'on ne pourra pas payer
async function verifierSolde(db, email, action, env) {
  const cout = TARIFS[action] || 0, solde = await soldeDe(db, email, env);
  if (solde < cout) throw new Erreur(402, solde ? `il te reste ${plCredits(solde)}, il en faut ${cout}` : "tu n'as plus de crédits");
  return solde;
}

async function crediter(db, email, n, motif, ref, env) {
  await soldeDe(db, email, env);
  try {
    await db.batch([
      db.prepare(`INSERT INTO mouvements_credits (email, date, delta, motif, ref) VALUES (?, ?, ?, ?, ?)`).bind(email, maintenant(), n, motif, ref || null),
      db.prepare(`UPDATE credits SET solde = solde + ? WHERE email = ?`).bind(n, email),
    ]);
  } catch (e) {
    if (ref && /UNIQUE/i.test(e.message || "")) return { deja: true };
    throw e;
  }
  const solde = (await db.prepare(`SELECT solde FROM credits WHERE email = ?`).bind(email).first()).solde;
  await db.prepare(`UPDATE mouvements_credits SET solde = ? WHERE id = (SELECT MAX(id) FROM mouvements_credits WHERE email = ?)`).bind(solde, email).run();
  await noter(db, email, "credits", motif);
  return { solde };
}

// Stripe : la signature prouve que l'événement vient bien de Stripe, avec le secret du webhook
async function webhookStripe(req, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Erreur(503, "paiement non configuré (STRIPE_WEBHOOK_SECRET)");
  const brut = await req.text();
  const sig = req.headers.get("Stripe-Signature") || "";
  const t = (sig.match(/(?:^|,)t=(\d+)/) || [])[1];
  const v1 = [...sig.matchAll(/(?:^|,)v1=([0-9a-f]+)/g)].map(x => x[1]);
  if (!t || !v1.length || Math.abs(Date.now() / 1000 - +t) > 300) throw new Erreur(400, "signature Stripe absente ou périmée");
  const enc = new TextEncoder();
  const cle = await crypto.subtle.importKey("raw", enc.encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", cle, enc.encode(`${t}.${brut}`)))]
    .map(b => b.toString(16).padStart(2, "0")).join("");
  const egal = (a, b) => a.length === b.length && [...a].reduce((x, c, i) => x | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
  if (!v1.some(v => egal(v, mac))) throw new Erreur(400, "signature Stripe invalide");
  const ev = JSON.parse(brut);
  if (ev.type !== "checkout.session.completed" && ev.type !== "checkout.session.async_payment_succeeded") return { ok: true, ignore: ev.type };
  const s = ev.data?.object || {};
  if (s.payment_status !== "paid") return { ok: true, ignore: "paiement pas encore encaissé" };
  let email = null;
  try { email = s.client_reference_id ? atob(s.client_reference_id.replace(/-/g, "+").replace(/_/g, "/")).toLowerCase() : null; } catch {}
  if (!email || !email.includes("@")) email = (s.customer_details?.email || s.customer_email || "").toLowerCase();
  const pack = PACKS[s.metadata?.pack] ? s.metadata.pack
    : Object.keys(PACKS).find(k => PACKS[k].prix * 100 === s.amount_total);
  if (!email || !pack) { console.error("paiement Stripe sans compte ou sans pack", s.id); return { ok: false, erreur: "compte ou pack introuvable" }; }
  const P = PACKS[pack], db = await base(env);
  const r = await crediter(db, email, P.credits + P.offerts,
    `pack ${P.nom} : ${plCredits(P.credits)}${P.offerts ? ` + ${P.offerts} offerts` : ""}`, s.id, env);
  return { ok: true, ...r };
}

async function enregistrerObjet(u, id, corps, env) {
  if (!ID.test(id)) throw new Erreur(400, "identifiant d'objet invalide");
  const d = corps.donnees;
  if (!d || typeof d !== "object") throw new Erreur(400, "donnees manquantes");
  const texte = JSON.stringify(d);
  if (texte.length > 200000) throw new Erreur(413, "fiche d'objet trop lourde");
  const db = await base(env);
  const existant = await db.prepare(`SELECT email FROM objets WHERE id = ?`).bind(id).first();
  if (existant && existant.email !== u.email) throw new Erreur(404, "objet introuvable");
  const t = maintenant();
  await db.prepare(`INSERT INTO objets (id, email, donnees, cree_le, maj_le) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET donnees = excluded.donnees, maj_le = excluded.maj_le`)
    .bind(id, u.email, texte, t, t).run();
  if (corps.photo) await enregistrerPhoto(u, id, corps.photo, env);
  if (!existant) await assurerVeille(db, u.email, id);
  else await apresNouvellesVentes(db, env, u.email, id, [], { reprise: true, silencieux: true });
  if (!existant) await noter(db, u.email, "objet", `« ${court(d.nom, 120) || "objet"} » entre dans l'espace`, id);
  return { ok: true, id };
}

function controlerPhoto(data) {
  if (typeof data !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(data))
    throw new Erreur(400, "photo attendue au format data:image");
  if (data.length > 1500000) throw new Erreur(413, "photo trop lourde, la réduire avant envoi");
}

/* La photo de couverture (rang 0) : celle des cartes. Elle remplace la précédente. */
async function enregistrerPhoto(u, id, data, env) {
  if (!ID.test(id)) throw new Erreur(400, "identifiant invalide");
  controlerPhoto(data);
  const db = await base(env);
  const o = await db.prepare(`SELECT 1 FROM objets WHERE id = ? AND email = ?`).bind(id, u.email).first();
  if (!o) throw new Erreur(404, "objet introuvable");
  const couv = await db.prepare(`SELECT id FROM photos WHERE objet_id = ? AND email = ? AND rang = 0`).bind(id, u.email).first();
  if (couv) await db.prepare(`UPDATE photos SET data = ?, maj_le = ? WHERE id = ?`).bind(data, maintenant(), couv.id).run();
  else await db.prepare(`INSERT INTO photos (id, objet_id, email, rang, data, maj_le) VALUES (?, ?, ?, 0, ?, ?)`)
    .bind(nouvelId(), id, u.email, data, maintenant()).run();
  return { ok: true };
}

/* Les autres vues de l'objet : dessous, marquages, étiquette, défauts. Huit au plus. */
async function ajouterPhoto(u, id, data, env) {
  controlerPhoto(data);
  const db = await base(env);
  await objetDe(db, u, id);
  const n = await db.prepare(`SELECT COUNT(*) AS n, MAX(rang) AS r FROM photos WHERE objet_id = ? AND email = ?`).bind(id, u.email).first();
  if (n.n >= 8) throw new Erreur(400, "huit photos au plus par objet");
  const pid = nouvelId();
  await db.prepare(`INSERT INTO photos (id, objet_id, email, rang, data, maj_le) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(pid, id, u.email, n.n ? (n.r || 0) + 1 : 0, data, maintenant()).run();
  return { ok: true, id: pid };
}

async function listerPhotos(u, id, env) {
  const db = await base(env);
  const { results } = await db.prepare(`SELECT id, rang, data FROM photos WHERE objet_id = ? AND email = ? ORDER BY rang`)
    .bind(id, u.email).all();
  return { photos: results };
}

async function supprimerPhoto(u, id, pid, env) {
  const db = await base(env);
  await db.prepare(`DELETE FROM photos WHERE id = ? AND objet_id = ? AND email = ?`).bind(pid, id, u.email).run();
  // si la couverture part, la vue suivante prend sa place
  const reste = await db.prepare(`SELECT id, rang FROM photos WHERE objet_id = ? AND email = ? ORDER BY rang LIMIT 1`).bind(id, u.email).first();
  if (reste && reste.rang !== 0) await db.prepare(`UPDATE photos SET rang = 0 WHERE id = ?`).bind(reste.id).run();
  return { ok: true };
}

async function supprimerObjet(u, id, env) {
  const db = await base(env);
  const o = await db.prepare(`SELECT donnees FROM objets WHERE id = ? AND email = ?`).bind(id, u.email).first();
  if (!o) throw new Erreur(404, "objet introuvable");
  await db.batch([
    db.prepare(`DELETE FROM objets WHERE id = ? AND email = ?`).bind(id, u.email),
    db.prepare(`DELETE FROM photos WHERE objet_id = ? AND email = ?`).bind(id, u.email),
    db.prepare(`DELETE FROM releves WHERE objet_id = ? AND email = ?`).bind(id, u.email),
    db.prepare(`DELETE FROM transactions WHERE objet_id = ? AND email = ?`).bind(id, u.email),
    db.prepare(`DELETE FROM veille WHERE objet_id = ? AND email = ?`).bind(id, u.email),
    db.prepare(`DELETE FROM anomalies WHERE objet_id = ? AND email = ?`).bind(id, u.email),
    // les lots suivis restent, détachés : une enchère peut intéresser sans l'objet
    db.prepare(`UPDATE lots SET objet_id = NULL WHERE objet_id = ? AND email = ?`).bind(id, u.email),
  ]);
  const nom = (() => { try { return JSON.parse(o.donnees).nom; } catch { return ""; } })();
  await noter(db, u.email, "objet", `« ${court(nom, 120) || "objet"} » retiré de l'espace`);
  return { ok: true };
}

async function objetDe(db, u, objet_id) {
  if (!objet_id) return null;
  const o = await db.prepare(`SELECT id FROM objets WHERE id = ? AND email = ?`).bind(objet_id, u.email).first();
  if (!o) throw new Erreur(404, "objet introuvable");
  return o.id;
}

/* Un relevé, c'est une photographie de la cote à une date : médiane, quartiles, nombre de
   fiches et nature de la base (ventes conclues, prix demandés, comparables, neuf). Ceux de
   l'atelier (source « atelier ») sont des estimations datées ; ceux de la collecte (source
   « collecte ») sont la cote du devis, calculée ici sur les ventes conclues. */
async function ajouterReleve(u, c, env) {
  const db = await base(env);
  const objet_id = await objetDe(db, u, c.objet_id);
  if (!objet_id) throw new Erreur(400, "objet_id requis");
  const med = nombre(c.mediane);
  if (med === null || med <= 0) throw new Erreur(400, "médiane absente");
  if (!devise(c.devise)) throw new Erreur(400, "devise ISO à trois lettres requise");
  const id = ID.test(c.id || "") ? c.id : nouvelId();
  await db.prepare(`INSERT OR IGNORE INTO releves (id, email, objet_id, date, base, nature, n, mediane,
                      q1, q3, min, max, devise, confiance, source, cree_le) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'atelier',?)`)
    .bind(id, u.email, objet_id, date10(c.date) || aujourdhui(), court(c.base, 120), court(c.nature, 30),
          nombre(c.n), med, nombre(c.q1), nombre(c.q3), nombre(c.min), nombre(c.max), devise(c.devise),
          court(c.confiance, 20), maintenant()).run();
  return { ok: true, id };
}

/* Une vente conclue. Même règle que le format pivot : sans adresse de page, pas de chiffre. */
async function ajouterTransaction(db, email, c) {
  if (!urlValide(c.url_source)) return { ok: false, raison: "pas d'url source" };
  const prix = nombre(c.prix);
  if (prix === null || prix <= 0) return { ok: false, raison: "prix absent ou nul" };
  if (!devise(c.devise)) return { ok: false, raison: "devise non ISO" };
  const id = nouvelId();
  const r = await db.prepare(`INSERT INTO transactions (id, email, objet_id, prix, devise, date, plateforme,
        url_source, cle, libelle, correspondance, origine, preuve, frais_inclus, lot_id, verifie, cree_le)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(email, cle) DO NOTHING`)
    .bind(id, email, c.objet_id || null, prix, devise(c.devise), date10(c.date), court(c.plateforme, 80) || domaine(c.url_source),
          c.url_source, cleUrl(c.url_source), court(c.libelle, 240), court(c.correspondance, 20),
          court(c.origine, 20) || "saisie", court(c.preuve, 300),
          c.frais_inclus === true ? 1 : c.frais_inclus === false ? 0 : null, c.lot_id || null,
          c.verifie === 1 || c.verifie === true ? 1 : c.verifie === 0 || c.verifie === false ? 0 : null, maintenant()).run();
  return r.meta?.changes ? { ok: true, id } : { ok: true, doublon: true };
}

async function routeTransactions(u, c, env) {
  const db = await base(env);
  const liste = Array.isArray(c.transactions) ? c.transactions.slice(0, 80) : [c];
  const sortie = [], touches = new Set();
  for (const t of liste) {
    const objet_id = await objetDe(db, u, t.objet_id);
    const r = await ajouterTransaction(db, u.email, { ...t, objet_id });
    sortie.push(r);
    if (r.id && objet_id) touches.add(objet_id);
  }
  // les ventes reprises à l'entrée d'un objet forment sa base : on recote, sans chercher d'anomalie
  for (const o of touches) await apresNouvellesVentes(db, env, u.email, o, [], { reprise: true });
  return { ok: true, resultats: sortie };
}

/* ---------- 3. les enchères ---------- */

async function enregistrerLot(u, id, c, env) {
  if (!ID.test(id)) throw new Erreur(400, "identifiant de lot invalide");
  const db = await base(env);
  const existant = await db.prepare(`SELECT * FROM lots WHERE id = ?`).bind(id).first();
  if (existant && existant.email !== u.email) throw new Erreur(404, "lot introuvable");
  const t = maintenant();
  if (!existant) {
    if (!urlValide(c.url)) throw new Erreur(400, "adresse du lot invalide");
    const cle = cleUrl(c.url);
    const deja = await db.prepare(`SELECT id FROM lots WHERE email = ? AND cle = ?`).bind(u.email, cle).first();
    if (deja) return { ok: true, id: deja.id, doublon: true };
    await db.prepare(`INSERT INTO lots (id, email, objet_id, url, cle, maison, titre, date_vente,
          estimation_basse, estimation_haute, enchere_actuelle, devise, statut, provenance, note, tentatives,
          cree_le, maj_le) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`)
      .bind(id, u.email, await objetDe(db, u, c.objet_id), c.url, cle, court(c.maison, 120) || domaine(c.url),
            court(c.titre, 300), date10(c.date_vente), nombre(c.estimation_basse), nombre(c.estimation_haute),
            nombre(c.enchere_actuelle), devise(c.devise) || "EUR", statutInitial(c), court(c.provenance, 30) || "saisie",
            court(c.note, 500), t, t).run();
    return { ok: true, id };
  }
  // mise à jour : seulement ce que la collectionneuse peut corriger à la main
  const champs = [], valeurs = [];
  const poser = (k, v) => { champs.push(`${k} = ?`); valeurs.push(v); };
  if ("objet_id" in c) poser("objet_id", await objetDe(db, u, c.objet_id));
  if ("titre" in c) poser("titre", court(c.titre, 300));
  if ("maison" in c) poser("maison", court(c.maison, 120));
  if ("date_vente" in c) poser("date_vente", date10(c.date_vente));
  if ("note" in c) poser("note", court(c.note, 500));
  if (!champs.length) return { ok: true, id };
  poser("maj_le", t);
  await db.prepare(`UPDATE lots SET ${champs.join(", ")} WHERE id = ? AND email = ?`)
    .bind(...valeurs, id, u.email).run();
  return { ok: true, id };
}

function statutInitial(c) {
  const d = date10(c.date_vente);
  if (c.statut === "en_cours") return "en_cours";
  if (d && d < aujourdhui()) return "a_relever";
  return "a_venir";
}

async function supprimerLot(u, id, env) {
  const db = await base(env);
  await db.prepare(`DELETE FROM lots WHERE id = ? AND email = ?`).bind(id, u.email).run();
  return { ok: true };
}

/* Résultat saisi à la main : la page est protégée contre les robots, ou la maison publie
   ses résultats ailleurs. Le chiffre est celui que la collectionneuse a lu ; l'adresse
   du lot reste la source, et la vente est marquée « saisie par toi ». */
async function saisirResultat(u, id, c, env) {
  const db = await base(env);
  const lot = await db.prepare(`SELECT * FROM lots WHERE id = ? AND email = ?`).bind(id, u.email).first();
  if (!lot) throw new Erreur(404, "lot introuvable");
  const etat = c.etat;
  if (!["adjuge", "invendu", "retire"].includes(etat)) throw new Erreur(400, "état attendu : adjuge, invendu ou retire");
  const prix = nombre(c.prix);
  if (etat === "adjuge" && (prix === null || prix <= 0)) throw new Erreur(400, "prix d'adjudication requis");
  const dev = devise(c.devise) || lot.devise || "EUR";
  const frais = c.frais_inclus === true ? 1 : c.frais_inclus === false ? 0 : null;
  await db.prepare(`UPDATE lots SET statut = ?, prix_adjuge = ?, devise = ?, frais_inclus = ?, provenance = 'saisie',
                    note = NULL, derniere_lecture = ?, maj_le = ? WHERE id = ?`)
    .bind(etat, etat === "adjuge" ? prix : null, dev, frais, maintenant(), maintenant(), id).run();
  let nouvelle = null;
  if (etat === "adjuge") {
    nouvelle = await ajouterTransaction(db, u.email, {
      objet_id: lot.objet_id, prix, devise: dev, date: lot.date_vente || aujourdhui(),
      plateforme: lot.maison, url_source: lot.url, libelle: lot.titre, origine: "saisie",
      preuve: "résultat recopié par la collectionneuse depuis la page du lot", frais_inclus: c.frais_inclus, lot_id: id });
  }
  if (nouvelle?.id && lot.objet_id) await apresNouvellesVentes(db, env, u.email, lot.objet_id, [nouvelle.id]);
  await noter(db, u.email, etat, messageResultat({ ...lot, statut: etat, prix_adjuge: prix, devise: dev, frais_inclus: frais }), lot.objet_id, id);
  return { ok: true, lot: await db.prepare(`SELECT * FROM lots WHERE id = ?`).bind(id).first() };
}

function messageResultat(l) {
  const t = `« ${court(l.titre, 90) || "lot"} »${l.maison ? " chez " + l.maison : ""}`;
  if (l.statut === "adjuge") return `${t} adjugé ${montant(l.prix_adjuge, l.devise)}${l.frais_inclus === 1 ? ", frais inclus" : l.frais_inclus === 0 ? ", hors frais" : ""}`;
  if (l.statut === "invendu") return `${t} invendu`;
  if (l.statut === "retire") return `${t} retiré de la vente`;
  if (l.statut === "a_verifier") return `${t} : un résultat a été lu mais son prix n'apparaît pas tel quel sur la page, à confirmer`;
  if (l.statut === "sans_resultat") return `${t} : aucun résultat publié ${JOURS_ATTENTE_RESULTAT} jours après la vente, relecture automatique arrêtée`;
  return `${t} : ${l.statut}`;
}

/* ---------- lecture d'une page de lot ---------- */

async function chargerPage(url) {
  const r = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
    },
  });
  const brut = await r.text();
  return { statut: r.status, html: brut.slice(0, 900000) };
}

const ENTITES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", euro: "€", pound: "£", eacute: "é",
  egrave: "è", agrave: "à", ccedil: "ç", ecirc: "ê", ocirc: "ô", ucirc: "û", icirc: "î", rsquo: "'", lsquo: "'",
  laquo: "«", raquo: "»", hellip: "...", ndash: "-", mdash: "-", thinsp: " ", nnbsp: " " };
function decoderEntites(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
          .replace(/&([a-z]+);/gi, (m, n) => ENTITES[n.toLowerCase()] ?? m);
}

/* On garde trois choses de la page : les données structurées (JSON-LD), les balises
   méta, et le texte visible. Les données structurées portent souvent le prix et la date
   de façon fiable ; le texte porte le résultat publié par la maison. */
function extrairePage(html) {
  const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1].trim()).join("\n").slice(0, 6000);
  const metas = [...html.matchAll(/<meta\s[^>]*>/gi)].map(m => m[0])
    .filter(m => /(og:title|og:description|name=["']description|price|currency|date)/i.test(m))
    .map(m => {
      const k = (/(?:property|name|itemprop)=["']([^"']+)/i.exec(m) || [])[1];
      const v = (/content=["']([^"']*)/i.exec(m) || [])[1];
      return k && v ? `${k}: ${decoderEntites(v)}` : null;
    }).filter(Boolean).join("\n").slice(0, 2000);
  const titre = decoderEntites(((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "").trim()).slice(0, 300);
  const texte = decoderEntites(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t  ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
  return { titre, ld, metas, texte };
}

/* Une page de lot est longue et l'essentiel n'est pas toujours en haut. On garde le début,
   puis des fenêtres autour des mots qui portent un résultat ou une estimation. */
const MOTS_CLES = /(adjug|estimat|résultat|resultat|vendu|invendu|ravalé|retiré|sold|hammer|realised|realized|unsold|withdrawn|current bid|enchère|prix|lot\s?n|frais|premium|clôtur|fin de vente|ends?\b)/gi;
function condenser(texte, max = 16000) {
  if (texte.length <= max) return texte;
  const tete = texte.slice(0, 6000);
  const fenetres = [];
  let total = tete.length;
  for (const m of texte.slice(6000).matchAll(MOTS_CLES)) {
    const a = Math.max(6000, 6000 + m.index - 400), z = Math.min(texte.length, a + 900);
    const dernier = fenetres[fenetres.length - 1];
    if (dernier && a <= dernier[1]) { total += z - dernier[1]; dernier[1] = Math.max(dernier[1], z); }
    else { fenetres.push([a, z]); total += z - a; }
    if (total >= max) break;
  }
  return tete + fenetres.map(([a, z]) => "\n[...]\n" + texte.slice(a, z)).join("");
}

/* Le chiffre lu par l'IA doit exister sur la page, écrit par la maison. On accepte les
   séparateurs de milliers usuels (espace, point, virgule, apostrophe) et un éventuel
   suffixe décimal ; on ne tolère aucune autre différence. */
function chiffreSurPage(v, ...sources) {
  if (v === null || v === undefined) return false;
  const entier = Math.trunc(Math.abs(v)).toString();
  const groupes = [];
  for (let i = entier.length; i > 0; i -= 3) groupes.unshift(entier.slice(Math.max(0, i - 3), i));
  const sep = "[\\s.,'  ]?";
  const motif = new RegExp(`(^|[^0-9.,])${groupes.join(sep)}([.,]\\d{1,2})?(?![0-9])`);
  return sources.some(s => s && motif.test(s));
}

const SYS_LECTURE = `Tu lis la page d'un lot de vente aux enchères, ou d'une annonce de vente, et tu
en relèves l'état. Tu ne produis jamais un chiffre : tu recopies ceux que la page écrit.

Ne confonds jamais trois choses :
  l'estimation, fourchette donnée par la maison avant la vente ;
  l'enchère en cours ou la mise à prix, pendant la vente ;
  le prix d'adjudication ou prix réalisé, publié après la vente.

etat :
  "adjuge" seulement si la page dit explicitement que le lot est vendu ou adjugé ET donne
           son prix (adjugé, vendu, résultat, prix réalisé, sold, hammer price, realised)
  "invendu" si la page dit invendu, ravalé, non vendu, unsold, passed, not sold
  "retire" si le lot est retiré de la vente, withdrawn
  "en_cours" si les enchères sont ouvertes : enchère actuelle, temps restant, enchérir
  "a_venir" si la vente est annoncée pour une date à venir et que rien n'est encore ouvert
  "termine_sans_resultat" si la vente est passée mais qu'aucun résultat n'est publié ici
  "illisible" si la page ne présente pas un lot précis : erreur, connexion obligatoire,
             blocage anti-robot, liste de résultats, page d'accueil

Chiffres : null si tu ne les vois pas écrits. Recopie le nombre tel qu'il figure, sans
conversion. frais_inclus : true si le prix publié inclut les frais acheteur (frais
compris, prix avec frais, buyer's premium included), false s'il s'agit du prix marteau
hors frais, null si la page ne le précise pas. date_vente : la date de la vente ou de
clôture, au format AAAA-MM-JJ. extrait : la phrase exacte de la page qui porte le
résultat ou l'estimation, recopiée mot pour mot, 200 caractères au plus.

Réponds uniquement par ce JSON, sans texte autour :
{"etat":"...","titre":"...","maison":"...","date_vente":null,"estimation_basse":null,
 "estimation_haute":null,"enchere_actuelle":null,"prix_adjuge":null,"devise":"EUR",
 "frais_inclus":null,"extrait":"..."}
N'utilise jamais de tiret long ni de tiret moyen.`;

async function demanderLecture(page, url, env) {
  if (!env.ANTHROPIC_API_KEY) throw new Erreur(503, "clé Anthropic absente du worker");
  const contenu = `Date du jour : ${aujourdhui()}\nAdresse : ${url}\nTitre de la page : ${page.titre}\n` +
    (page.metas ? `Balises méta :\n${page.metas}\n` : "") +
    (page.ld ? `Données structurées :\n${page.ld}\n` : "") +
    `Texte de la page :\n${condenser(page.texte)}`;
  const r = await fetch(env.ANTHROPIC_URL || ANTHROPIC, {   // ANTHROPIC_URL ne sert qu'aux tests
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.MODELE_LECTURE || MODELE_LECTURE, max_tokens: 700, system: SYS_LECTURE,
                           messages: [{ role: "user", content: contenu }] }),
  });
  if (!r.ok) throw new Erreur(502, `lecture IA impossible (${r.status})`);
  const d = await r.json();
  const t = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const a = t.indexOf("{"), z = t.lastIndexOf("}");
  if (a === -1 || z <= a) throw new Erreur(502, "lecture IA sans réponse exploitable");
  return JSON.parse(t.slice(a, z + 1));
}

/* Relit un lot et met la base à jour. Renvoie le lot tel qu'il est après lecture. */
async function relireLot(db, lot, env) {
  const t = maintenant();
  let page = null, lecture = null, panne = null;
  try {
    const p = await chargerPage(lot.url);
    if (p.statut === 404 || p.statut === 410) panne = "page disparue";
    else if (p.statut >= 400) panne = `page refusée au robot (${p.statut}), protection probable`;
    else page = extrairePage(p.html);
  } catch (e) { panne = "page injoignable"; }
  if (page && page.texte.length < 200 && !page.ld) panne = "page vide pour le robot, contenu chargé en JavaScript";
  if (page && !panne) {
    try { lecture = await demanderLecture(page, lot.url, env); }
    catch (e) { panne = e.message; }
  }

  const maj = { derniere_lecture: t, maj_le: t, tentatives: (lot.tentatives || 0) + 1 };
  const passee = lot.date_vente && lot.date_vente < aujourdhui();
  let nouveauStatut = lot.statut, evenement = null, transaction = null;

  if (lecture && lecture.etat !== "illisible") {
    const sources = [page.texte, page.ld, page.metas];
    const verifie = v => { const n = nombre(v); return n !== null && n > 0 && chiffreSurPage(n, ...sources) ? n : null; };
    maj.note = null;   // la page a été lue : l'ancien message de panne ne vaut plus
    if (lecture.titre && !lot.titre) maj.titre = court(lecture.titre, 300);
    if (lecture.maison && (!lot.maison || lot.maison === domaine(lot.url))) maj.maison = court(lecture.maison, 120);
    if (date10(lecture.date_vente)) maj.date_vente = date10(lecture.date_vente);
    if (devise(lecture.devise)) maj.devise = devise(lecture.devise);
    const eb = verifie(lecture.estimation_basse), eh = verifie(lecture.estimation_haute);
    if (eb) maj.estimation_basse = eb;
    if (eh) maj.estimation_haute = eh;
    if (eb || eh) maj.provenance = "page";
    const ea = verifie(lecture.enchere_actuelle);
    if (ea) maj.enchere_actuelle = ea;
    if (court(lecture.extrait, 200)) maj.extrait = court(lecture.extrait, 200);
    maj.frais_inclus = lecture.frais_inclus === true ? 1 : lecture.frais_inclus === false ? 0 : null;

    const dateRef = maj.date_vente || lot.date_vente;
    switch (lecture.etat) {
      case "adjuge": {
        const prix = verifie(lecture.prix_adjuge);
        if (prix) {
          nouveauStatut = "adjuge"; maj.prix_adjuge = prix; maj.provenance = "page";
          transaction = { objet_id: lot.objet_id, prix, devise: maj.devise || lot.devise || "EUR",
            date: dateRef || aujourdhui(), plateforme: maj.maison || lot.maison, url_source: lot.url,
            libelle: maj.titre || lot.titre, origine: "enchere", lot_id: lot.id,
            frais_inclus: lecture.frais_inclus,
            preuve: `lu sur la page le ${aujourdhui()}${maj.extrait ? " : " + maj.extrait : ""}` };
        } else {
          nouveauStatut = "a_verifier";
          maj.note = "un résultat a été lu, mais son prix n'est pas écrit tel quel sur la page : ouvre le lien et saisis-le";
        }
        break;
      }
      case "invendu": nouveauStatut = "invendu"; break;
      case "retire": nouveauStatut = "retire"; break;
      case "en_cours": nouveauStatut = "en_cours"; break;
      case "a_venir": nouveauStatut = dateRef && dateRef < aujourdhui() ? "a_relever" : "a_venir"; break;
      default: nouveauStatut = "a_relever";
    }
    if (["adjuge", "invendu", "retire", "a_verifier"].includes(nouveauStatut) && nouveauStatut !== lot.statut) evenement = nouveauStatut;
  } else {
    // rien de lisible : on garde le statut, mais une vente passée bascule en « à relever »
    if (passee && ["a_venir", "en_cours"].includes(lot.statut)) nouveauStatut = "a_relever";
    maj.note = panne ? `dernière lecture : ${panne}. Ouvre le lien et saisis le résultat si la page l'affiche.`
                     : "la page ne présente pas un lot lisible : ouvre le lien et saisis le résultat";
  }

  // au-delà de trois semaines sans résultat, on cesse de relire seul : ça coûte sans rien rapporter
  const dateFinale = maj.date_vente || lot.date_vente;
  if (nouveauStatut === "a_relever" && dateFinale) {
    const ecart = (Date.parse(aujourdhui()) - Date.parse(dateFinale)) / 864e5;
    if (ecart > JOURS_ATTENTE_RESULTAT) { nouveauStatut = "sans_resultat"; evenement = "sans_resultat"; }
  }
  maj.statut = nouveauStatut;

  const cles = Object.keys(maj);
  await db.prepare(`UPDATE lots SET ${cles.map(k => k + " = ?").join(", ")} WHERE id = ?`)
    .bind(...cles.map(k => maj[k]), lot.id).run();
  if (transaction) {
    const t = await ajouterTransaction(db, lot.email, transaction);
    if (t.id && lot.objet_id) await apresNouvellesVentes(db, env, lot.email, lot.objet_id, [t.id]);
  }
  const apres = await db.prepare(`SELECT * FROM lots WHERE id = ?`).bind(lot.id).first();
  if (evenement) await noter(db, lot.email, evenement, messageResultat(apres), lot.objet_id, lot.id);
  return apres;
}

/* La tournée du matin : tous les lots dont la vente est passée ou en cours, plus ceux qui
   n'ont pas été relus depuis une semaine. Plafonnée, pour que la facture reste prévisible :
   une lecture coûte moins d'un centime. */
async function tournee(env, email) {
  const db = await base(env);
  const limite = Math.min(+env.LIMITE_TOURNEE || 30, 100);
  const semaine = new Date(Date.now() - 7 * 864e5).toISOString();
  const demain = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const filtreEmail = email ? "AND email = ?" : "";
  const q = db.prepare(`SELECT * FROM lots WHERE statut IN ('a_venir', 'en_cours', 'a_relever') ${filtreEmail}
      AND ((date_vente IS NOT NULL AND date_vente <= ?) OR derniere_lecture IS NULL OR derniere_lecture < ?)
      ORDER BY (derniere_lecture IS NOT NULL), date_vente LIMIT ?`);
  const { results } = await (email ? q.bind(email, demain, semaine, limite) : q.bind(demain, semaine, limite)).all();
  const bilan = { relus: 0, adjuges: 0, erreurs: 0 };
  for (const lot of results) {
    try {
      const apres = await relireLot(db, lot, env);
      bilan.relus++;
      if (apres.statut === "adjuge" && lot.statut !== "adjuge") bilan.adjuges++;
    } catch { bilan.erreurs++; }
  }
  return bilan;
}

/* ---------- 4. la cote : calculée par le code, jamais par l'IA ---------- */

const arrondi = v => v === null || v === undefined || isNaN(v) ? null : Math.round(v);
function mediane(t) {
  const s = [...t].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(s, p) {
  const i = (s.length - 1) * p, b = Math.floor(i), f = i - b;
  return s[b + 1] !== undefined ? s[b] + f * (s[b + 1] - s[b]) : s[b];
}

/* Les ventes qui comptent : celles de cet objet (même modèle, jamais un autre modèle de la
   marque), conclues dans les douze derniers mois. Une vente dont la page ne donne pas la
   date compte à la date où elle a été trouvée : une fiche « vendu » encore en ligne est
   presque toujours récente, et c'est écrit sur la fiche de l'objet. */
function ventesDuMarche(trans, jours = 365) {
  const t0 = Date.now();
  return trans.filter(t => !["famille", "comparable"].includes(t.correspondance))
    .map(t => ({ ...t, quand: Date.parse((t.date || t.cree_le || "").slice(0, 10) + "T12:00:00Z"), datee: !!t.date }))
    .filter(t => !isNaN(t.quand) && t.quand >= t0 - jours * 864e5 && t.quand <= t0 + 864e5);
}

/* Règle du devis (bloc 4) : une cote seulement à partir de trois ventes conclues sur douze
   mois, sinon « non cotable ». Les prix demandés n'y entrent jamais. */
function calculerCote(trans) {
  const pertinentes = ventesDuMarche(trans);
  if (!pertinentes.length) return { cotable: false, n: 0, raison: "aucune vente conclue sur les douze derniers mois" };
  const comptes = {};
  pertinentes.forEach(t => { comptes[t.devise] = (comptes[t.devise] || 0) + 1; });
  const dev = Object.keys(comptes).sort((a, b) => comptes[b] - comptes[a])[0];
  const v = pertinentes.filter(t => t.devise === dev);
  const base = { n: v.length, devise: dev, autres_devises: pertinentes.length - v.length,
                 datees: v.filter(t => t.datee).length, verifiees: v.filter(t => t.verifie === 1).length };
  if (v.length < 3) return { ...base, cotable: false,
    raison: `${v.length} vente${v.length > 1 ? "s" : ""} conclue${v.length > 1 ? "s" : ""} sur douze mois, il en faut trois` };

  const p = v.map(t => t.prix).sort((a, b) => a - b);
  const moy = p.reduce((a, b) => a + b, 0) / p.length;
  const et = Math.sqrt(p.reduce((a, x) => a + (x - moy) ** 2, 0) / (p.length - 1));
  const r = { ...base, cotable: true, moyenne: arrondi(moy), mediane: arrondi(mediane(p)), min: p[0], max: p[p.length - 1],
    q1: p.length >= 4 ? arrondi(quantile(p, .25)) : null, q3: p.length >= 4 ? arrondi(quantile(p, .75)) : null,
    volatilite: moy ? Math.round(et / moy * 1000) / 10 : null,     // écart-type en % de la moyenne
    confiance: v.length >= 8 ? "forte" : v.length >= 5 ? "moyenne" : "faible" };

  // tendance : droite des moindres carrés sur les ventes datées. Une vente qui sort du rythme
  // (même règle que l'anomalie) compte dans la cote mais pas dans la tendance : une seule pièce
  // exceptionnelle ne doit pas faire croire que tout le modèle s'envole.
  const m0 = mediane(p), e0 = Math.max(1.4826 * mediane(p.map(x => Math.abs(x - m0))), 0.05 * m0);
  const horsRythme = t => Math.abs(t.prix - m0) / e0 >= 2.5;
  r.hors_rythme = v.filter(horsRythme).length;
  const pts = v.filter(t => t.datee && !horsRythme(t)).map(t => ({ x: (t.quand - Date.now()) / 864e5, y: t.prix }));
  const etendue = pts.length ? Math.max(...pts.map(q => q.x)) - Math.min(...pts.map(q => q.x)) : 0;
  if (pts.length >= 4 && etendue >= 30) {
    const mx = pts.reduce((a, q) => a + q.x, 0) / pts.length, my = pts.reduce((a, q) => a + q.y, 0) / pts.length;
    const sxx = pts.reduce((a, q) => a + (q.x - mx) ** 2, 0);
    const b = pts.reduce((a, q) => a + (q.x - mx) * (q.y - my), 0) / sxx, a0 = my - b * mx;
    const res = pts.map(q => q.y - (a0 + b * q.x)), ssr = res.reduce((a, e) => a + e * e, 0);
    const sres = Math.sqrt(ssr / Math.max(1, pts.length - 2));
    const stot = pts.reduce((a, q) => a + (q.y - my) ** 2, 0);
    const pente = b * 30 / my;                                       // variation par mois, en part de la moyenne
    r.tendance = { sens: pente > 0.02 ? "hausse" : pente < -0.02 ? "baisse" : "stable",
      pente_mois: Math.round(pente * 1000) / 10, r2: stot ? Math.round((1 - ssr / stot) * 100) / 100 : null,
      n: pts.length, jours: Math.round(etendue) };
    // projection : la même droite prolongée de trois mois, avec une bande à 80 %, seulement si
    // la droite explique au moins 30 % des écarts ; sinon le marché est trop irrégulier pour la prolonger
    const r2 = stot ? 1 - ssr / stot : 0;
    if (pts.length >= 6 && etendue >= 60 && r2 < 0.3) r.tendance.projection_refusee = "ventes trop irrégulières pour prolonger la tendance";
    if (pts.length >= 6 && etendue >= 60 && r2 >= 0.3) {
      const h = 90, val = a0 + b * h, e = 1.28 * sres;
      r.projection = { jours: h, date: new Date(Date.now() + h * 864e5).toISOString().slice(0, 10),
        depart: arrondi(a0), valeur: arrondi(Math.max(0, val)), bas: arrondi(Math.max(0, val - e)), haut: arrondi(val + e) };
    }
  } else {
    r.tendance = { sens: "inconnue", n: pts.length,
      raison: "il faut au moins quatre ventes datées, étalées sur un mois, pour dégager une tendance" };
  }
  return r;
}

/* Les montants des messages et des e-mails, écrits à la française : 2 600 €, 30,5. */
const montant = (v, dev) => `${Math.round(v).toLocaleString("fr-FR")} ${dev === "EUR" ? "€" : dev || ""}`.trim();
const virgule = (v, n = 1) => v.toFixed(n).replace(".", ",");

const palierDe = r => r >= 1 ? "+100" : r >= 0.5 ? "+50" : r <= -0.25 ? "-25" : null;
const LIB_PALIER = { "+100": "a doublé par rapport à ton prix d'achat", "+50": "dépasse de 50 % ton prix d'achat",
                     "-25": "est passée 25 % sous ton prix d'achat" };

async function assurerVeille(db, email, objet_id) {
  await db.prepare(`INSERT OR IGNORE INTO veille (objet_id, email, echecs, maj_le) VALUES (?, ?, 0, ?)`)
    .bind(objet_id, email, maintenant()).run();
}

/* Après toute nouvelle vente conclue d'un objet (veille, enchère relevée, saisie, reprise de
   l'atelier) : on recote, on garde le relevé du jour, on cherche l'anomalie, on regarde les
   paliers. L'anomalie se mesure au rythme propre de l'objet, pas à un seuil fixe : une vente
   est anormale si elle s'écarte de la médiane de plus de deux fois et demie l'écart habituel
   de SES prix. Un objet très volatil bouge sans alerter ; un objet stable alerte vite. */
async function apresNouvellesVentes(db, env, email, objet_id, nouvelles = [], opts = {}) {
  const o = await db.prepare(`SELECT * FROM objets WHERE id = ? AND email = ?`).bind(objet_id, email).first();
  if (!o) return null;
  const dn = lireJSONsur(o.donnees) || {};
  const { results: trans } = await db.prepare(`SELECT * FROM transactions WHERE objet_id = ? AND email = ?`).bind(objet_id, email).all();
  const cote = calculerCote(trans);
  const etat = await db.prepare(`SELECT * FROM veille WHERE objet_id = ?`).bind(objet_id).first();
  const t = maintenant(), jour = aujourdhui();

  if (cote.cotable) await db.batch([
    db.prepare(`DELETE FROM releves WHERE objet_id = ? AND email = ? AND source = 'collecte' AND date = ?`).bind(objet_id, email, jour),
    db.prepare(`INSERT INTO releves (id, email, objet_id, date, base, nature, n, mediane, q1, q3, min, max, devise,
                confiance, source, cree_le) VALUES (?,?,?,?,?,'obtenu',?,?,?,?,?,?,?,?,'collecte',?)`)
      .bind(nouvelId(), email, objet_id, jour, "ventes conclues sur douze mois", cote.n, cote.mediane, cote.q1, cote.q3,
            cote.min, cote.max, cote.devise, cote.confiance, t),
  ]);

  const anomalies = [];
  if (!opts.reprise && nouvelles.length) {
    const marche = ventesDuMarche(trans);
    for (const id of nouvelles) {
      const v = marche.find(x => x.id === id);
      if (!v) continue;
      const autres = marche.filter(x => x.id !== id && x.devise === v.devise).map(x => x.prix);
      if (autres.length < 5) continue;                 // pas encore de rythme établi
      const m = mediane(autres);
      const ecart = Math.max(1.4826 * mediane(autres.map(x => Math.abs(x - m))), 0.05 * m);
      const z = (v.prix - m) / ecart;
      if (Math.abs(z) >= 2.5) anomalies.push({ type: "prix", transaction: v, ampleur: (v.prix - m) / m,
        message: `vente conclue à ${montant(v.prix, v.devise)}${v.plateforme ? " sur " + v.plateforme : ""}, ` +
          `${Math.round(Math.abs(v.prix - m) / m * 100)} % ${v.prix > m ? "au-dessus" : "en dessous"} de sa médiane habituelle ` +
          `(${montant(m, v.devise)}), soit ${virgule(Math.abs(z))} fois l'écart ordinaire de ses prix` });
    }
    // le rythme des ventes : un afflux sur trente jours, au regard des onze mois d'avant
    const t0 = Date.now(), mois = 30 * 864e5;
    const recentes = marche.filter(x => x.quand >= t0 - mois).length;
    const avant = marche.filter(x => x.quand < t0 - mois).length, attendu = avant / 11;
    if (avant >= 6 && recentes >= 3 && recentes >= 3 * attendu) {
      const deja = await db.prepare(`SELECT 1 FROM anomalies WHERE objet_id = ? AND type = 'rythme' AND date >= ?`)
        .bind(objet_id, new Date(t0 - mois).toISOString().slice(0, 10)).first();
      if (!deja) anomalies.push({ type: "rythme", ampleur: recentes / attendu - 1,
        message: `${recentes} ventes conclues en trente jours, contre ${virgule(attendu)} par mois d'habitude` });
    }
  }
  for (const a of anomalies.slice(0, 2)) {
    const id = nouvelId();
    await db.prepare(`INSERT INTO anomalies (id, email, objet_id, date, type, ampleur, message, transaction_id, cree_le)
                      VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(id, email, objet_id, jour, a.type, a.ampleur, a.message, a.transaction?.id || null, t).run();
    let ex;
    try { ex = await expliquer(env, dn, a, cote); } catch (e) { ex = { erreur: e.message || "explication impossible" }; }
    await db.prepare(`UPDATE anomalies SET explication = ? WHERE id = ?`).bind(JSON.stringify(ex), id).run();
    await noter(db, email, "anomalie", `« ${court(dn.nom, 90) || "objet"} » : ${a.message}`, objet_id);
    if (await envoyerEmail(env, email, `${dn.nom || "Un objet"} sort de son rythme`, htmlAnomalie(env, dn, a, ex, cote)))
      await db.prepare(`UPDATE anomalies SET notifie = 1 WHERE id = ?`).bind(id).run();
  }

  // paliers du devis (bloc 5) : +50 %, +100 %, -25 % de la cote par rapport au prix payé
  const s = dn.situation || {};
  let palier = etat?.palier ?? null;
  const premiere = !etat || !etat.cote;
  if (cote.cotable && s.prix > 0 && (s.devise || "EUR") === cote.devise && (s.mode || "collection") === "collection") {
    const ratio = (cote.mediane - s.prix) / s.prix, p = palierDe(ratio);
    if (p !== palier) {
      if (p && !premiere && !opts.silencieux) {
        const id = nouvelId();
        const message = `la cote (${montant(cote.mediane, cote.devise)}) ${LIB_PALIER[p]} (${montant(s.prix, cote.devise)}), ` +
          `${ratio > 0 ? "+" : ""}${Math.round(ratio * 100)} %`;
        await db.prepare(`INSERT INTO anomalies (id, email, objet_id, date, type, ampleur, message, cree_le)
                          VALUES (?,?,?,?,'palier',?,?,?)`).bind(id, email, objet_id, jour, ratio, message, t).run();
        await noter(db, email, "palier", `« ${court(dn.nom, 90) || "objet"} » : ${message}`, objet_id);
        if (await envoyerEmail(env, email, `${dn.nom || "Un objet"} : palier ${p} %`, gabarit(env, `${dn.nom || "Un objet"} : palier ${p} %`,
            `<p style="font-size:15px;line-height:1.5">${escH(message[0].toUpperCase() + message.slice(1))}.</p>
             <p style="font-size:13px;color:#5a6189">Cote calculée sur ${cote.n} ventes conclues des douze derniers mois.</p>`)))
          await db.prepare(`UPDATE anomalies SET notifie = 1 WHERE id = ?`).bind(id).run();
      }
      palier = p;
    }
  }
  await db.prepare(`INSERT INTO veille (objet_id, email, cote, palier, echecs, maj_le) VALUES (?, ?, ?, ?, 0, ?)
                    ON CONFLICT(objet_id) DO UPDATE SET cote = excluded.cote, palier = excluded.palier, maj_le = excluded.maj_le`)
    .bind(objet_id, email, JSON.stringify(cote), palier, t).run();
  return { cote, anomalies: anomalies.length };
}

/* ---------- 5. le moteur d'explication, seulement en cas d'anomalie ---------- */

const SYS_EXPLICATION = `Tu expliques à une collectionneuse pourquoi un objet de sa collection vient de
s'écarter de son rythme habituel sur le marché. On te donne l'objet, le mouvement observé et
le rythme habituel, calculé sur ses ventes conclues des douze derniers mois.

Cherche sur le web ce qui peut l'expliquer : actualité de la marque ou du créateur, réédition
ou arrêt du modèle, rappel ou polémique, exposition, film ou série, effet de mode sur les
réseaux, dispersion d'une collection connue, état ou provenance particulière de la pièce
vendue, erreur probable d'annonce.

Propose au plus trois hypothèses, de la plus probable à la moins probable, chacune avec un
niveau de confiance en pourcentage et la source qui l'appuie : l'URL exacte d'une page que ta
recherche a réellement consultée, ou null si l'hypothèse ne repose que sur le raisonnement.
Une hypothèse sans source ne dépasse pas 40 %.

Tu ne produis aucun prix, aucune estimation, aucun chiffre de valeur : ils sont calculés par
ailleurs. Ce sont des hypothèses, pas des faits établis, et jamais un conseil
d'investissement. Tu la tutoies, sans formule d'introduction.

Format :
{"resume":"l'explication retenue, en une phrase",
 "hypotheses":[{"hypothese":"une phrase","pourquoi":"deux phrases au plus","confiance":0,"source":"url ou null"}]}`;

const sansTirets = v => typeof v === "string"
  ? v.replace(/\s*[\u2014\u2013]\s*/g, ", ").replace(/\u00b7/g, ",").replace(/\u2026/g, ".") : v;

async function expliquer(env, dn, a, cote) {
  const r = await claude(env, {
    model: env.MODELE_EXPLICATION || MODELE_EXPLICATION, system: SYS_EXPLICATION, recherches: 4, max_tokens: 2500,
    contenu: `Date du jour : ${aujourdhui()}\nOBJET : ${dn.description || dn.nom || "?"}\n` +
      `marque : ${dn.marque || "?"}, modèle : ${dn.modele || "?"}, référence : ${dn.reference || "?"}, univers : ${dn.univers || "?"}\n` +
      `MOUVEMENT : ${a.message}\n` + (a.transaction ? `page de la vente : ${a.transaction.url_source}\n` : "") +
      `RYTHME HABITUEL : ${cote.cotable ? `${cote.n} ventes conclues sur douze mois, volatilité ${cote.volatilite} %, ` +
        `tendance ${cote.tendance?.sens || "inconnue"}` : "pas encore de cote établie"}`,
  });
  const j = lireJSON(r.texte);
  const hypotheses = (j.hypotheses || []).map(h => {
    const src = h.source && urlValide(h.source) && r.consultees.has(cleUrl(h.source)) ? h.source : null;
    let c = Math.max(0, Math.min(100, Math.round(+h.confiance || 0)));
    if (!src) c = Math.min(c, 40);                    // une source inventée ne compte pas
    return { hypothese: sansTirets(court(h.hypothese, 300)), pourquoi: sansTirets(court(h.pourquoi, 400)), confiance: c, source: src };
  }).filter(h => h.hypothese).sort((x, y) => y.confiance - x.confiance).slice(0, 3);
  return { resume: sansTirets(court(j.resume, 300)), hypotheses, recherches: r.recherches, date: aujourdhui() };
}

/* Appel à Claude côté serveur, avec la recherche web si demandée. Renvoie le texte et la
   liste des pages réellement consultées : une adresse qui n'y figure pas est écartée. */
const propreBlocs = c => (c || []).filter(b => b.type !== "text" || (b.text || "").trim());
async function claude(env, { model, system, contenu, recherches, max_tokens }) {
  if (!env.ANTHROPIC_API_KEY) throw new Erreur(503, "clé Anthropic absente du worker");
  const corps = { model, max_tokens, messages: [{ role: "user", content: contenu }],
    system: system + "\n\nRéponds uniquement par du JSON valide, sans préambule ni balises de code." +
      " N'utilise jamais de tiret long ni de tiret moyen." };
  if (recherches) corps.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: recherches,
                                   user_location: { type: "approximate", country: "FR" } }];
  const appel = async () => {
    const r = await fetch(env.ANTHROPIC_URL || ANTHROPIC, { method: "POST", body: JSON.stringify(corps),
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } });
    if (!r.ok) throw new Erreur(502, `IA indisponible (${r.status})`);
    return r.json();
  };
  const lu = [];
  let d = await appel(); lu.push(...(d.content || []));
  for (let i = 0; d.stop_reason === "pause_turn" && i < 2; i++) {
    corps.messages = [...corps.messages, { role: "assistant", content: propreBlocs(d.content) }];
    d = await appel(); lu.push(...(d.content || []));
  }
  const texte = c => c.filter(b => b.type === "text").map(b => b.text).join("\n");
  if (texte(lu).indexOf("{") === -1) {
    corps.messages = [...corps.messages, { role: "assistant", content: propreBlocs(d.content) },
      { role: "user", content: "Tes recherches sont terminées. Rédige UNIQUEMENT le JSON demandé, sans nouvelle recherche." }];
    corps.tool_choice = { type: "none" };
    d = await appel(); lu.push(...(d.content || []));
  }
  const consultees = new Set();
  lu.forEach(b => {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content))
      b.content.forEach(x => x.url && consultees.add(cleUrl(x.url)));
  });
  let t = texte(d.content || []);
  if (t.indexOf("{") === -1) t = texte(lu);
  return { texte: t, consultees, recherches: lu.filter(b => b.type === "server_tool_use").length };
}

function lireJSONsur(t) { try { return t ? JSON.parse(t) : null; } catch { return null; } }

/* Une réponse coupée reste exploitable : on referme les structures ouvertes. */
function lireJSON(t) {
  t = String(t || "").replace(/^```(?:json)?/m, "").replace(/```$/m, "");
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), z = t.lastIndexOf("}");
  if (a !== -1 && z > a) { try { return JSON.parse(t.slice(a, z + 1)); } catch {} }
  if (a === -1) throw new Erreur(502, "réponse de l'IA sans JSON");
  const s = t.slice(a), pile = [];
  let dansTexte = false, echap = false, dernier = -1, fermeture = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (echap) { echap = false; continue; }
    if (c === "\\") { echap = true; continue; }
    if (c === '"') { dansTexte = !dansTexte; continue; }
    if (dansTexte) continue;
    if (c === "{") pile.push("}"); else if (c === "[") pile.push("]");
    else if (c === "}" || c === "]") { pile.pop(); dernier = i; fermeture = [...pile].reverse().join(""); }
  }
  if (dernier > 0) { try { return JSON.parse(s.slice(0, dernier + 1) + fermeture); } catch {} }
  throw new Erreur(502, "réponse de l'IA illisible");
}

/* ---------- 6. les e-mails ---------- */

const escH = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* Envoi par l'API de Brevo (gratuite jusqu'à 300 e-mails par jour). Sans réglage, l'alerte
   reste dans l'espace et le journal : rien ne casse. */
async function envoyerEmail(env, a, sujet, html) {
  if (!env.BREVO_API_KEY || !env.EMAIL_EXPEDITEUR || !a) return false;
  try {
    const r = await fetch(env.BREVO_URL || "https://api.brevo.com/v3/smtp/email", {   // BREVO_URL ne sert qu'aux tests
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: "Le Collectionnaire", email: env.EMAIL_EXPEDITEUR },
                             to: [{ email: a }], subject: "Le Collectionnaire : " + sujet, htmlContent: html }),
    });
    return r.ok;
  } catch { return false; }
}

function gabarit(env, titre, corps) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#131f6a;max-width:560px;margin:0 auto">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
      <td style="height:6px;background:#059be1"></td><td style="height:6px;background:#f8c81f"></td>
      <td style="height:6px;background:#d62c7c"></td></tr></table>
    <h1 style="font-family:Georgia,serif;font-weight:400;font-size:24px;line-height:1.2;margin:20px 0 10px">${escH(titre)}</h1>
    ${corps}
    <p style="margin:24px 0"><a href="${escH(env.URL_ESPACE || URL_ESPACE)}" style="background:#131f6a;color:#ffffff;
      padding:11px 22px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:14px">ouvrir mon espace</a></p>
    <p style="font-size:12px;color:#5a6189;line-height:1.5">Le Collectionnaire. Les chiffres sont calculés sur des ventes
      conclues dont chaque page est conservée. Les hypothèses ne sont pas des faits établis et ne constituent pas un
      conseil en investissement.</p></div>`;
}

function htmlAnomalie(env, dn, a, ex, cote) {
  const hyp = (ex?.hypotheses || []).map(h => `<li style="margin:0 0 12px"><b>${escH(h.hypothese)}</b>
      <span style="color:#5a6189">(confiance ${h.confiance} %)</span><br><span style="font-size:13px">${escH(h.pourquoi || "")}</span>
      <br>${h.source ? `<a href="${escH(h.source)}" style="font-size:12px;color:#0a6fa6">source</a>`
        : `<span style="font-size:12px;color:#5a6189">sans source, raisonnement seul</span>`}</li>`).join("");
  return gabarit(env, `${dn.nom || "Un objet"} sort de son rythme`, `
    <p style="font-size:15px;line-height:1.55"><b>Le mouvement :</b> ${escH(a.message)}.</p>
    ${a.transaction ? `<p style="margin:0 0 14px"><a href="${escH(a.transaction.url_source)}" style="color:#0a6fa6">voir la vente</a></p>` : ""}
    ${ex?.resume ? `<p style="font-size:15px;line-height:1.55"><b>L'explication retenue :</b> ${escH(ex.resume)}</p>` : ""}
    ${hyp ? `<ol style="padding-left:20px;font-size:14px;line-height:1.45">${hyp}</ol>`
          : `<p style="font-size:14px">Aucune explication solide trouvée pour l'instant.</p>`}
    ${cote?.cotable ? `<p style="font-size:13px;color:#5a6189">Cote actuelle : ${escH(montant(cote.mediane, cote.devise))}, sur ${cote.n}
      ventes conclues des douze derniers mois.</p>` : ""}`);
}

/* ---------- 7. la veille quotidienne des ventes conclues (bloc 3) ---------- */

const SYS_VEILLE = `Tu cherches sur le web les VENTES CONCLUES récentes d'un objet de collection précis :
annonces marquées vendues, lots adjugés, transactions terminées des douze derniers mois. Jamais une
annonce encore en vente, jamais un prix demandé.

Méthode : choisis les places de marché propres à cet univers, entre particuliers, revendeurs et
enchères, et interroge-les avec l'opérateur site: suivi des termes de la signature de veille,
du plus précis au plus large. Écarte tout ce qui contient un terme exclu.

Ne retiens QUE des pages consacrées à UN article vendu. Jamais une page de résultats, de
catégorie ou d'article de blog. L'URL doit être exactement celle d'un résultat de ta recherche :
ne la reconstruis pas, ne la complète pas.

Pour chaque vente :
- prix : le prix final tel qu'il est écrit sur la page, null s'il n'y figure pas. N'estime jamais.
- date_vente : la date de la vente si la page l'indique, AAAA-MM-JJ, sinon null
- correspondance : "exacte" (même modèle, mêmes attributs distinctifs), "modele" (même modèle,
  un attribut différent), "famille" (même marque, autre modèle). Dans le doute, le plus éloigné.

Vise entre 3 et 15 ventes. Aucune vente vaut mieux qu'une vente hors sujet.

Format :
{"ventes":[{"plateforme":"...","url":"...","titre":"...","prix":0,"devise":"EUR","date_vente":null,
  "correspondance":"exacte|modele|famille"}]}`;

const rythmeDe = dn => dn.rythme || (dn.situation?.mode === "achat" ? "arretee" : "quotidienne");

function estPageDeRecherche(u) {
  try {
    const x = new URL(u), c = x.pathname.toLowerCase();
    if (/(^|\/)(search|recherche|suche|busqueda|ricerca|catalog|catalogue|browse|sch)(\/|$)/.test(c)) return true;
    return ["q", "query", "keyword", "keywords", "search_text", "_nkw", "text", "k", "term", "searchterm"].some(p => x.searchParams.has(p));
  } catch { return false; }
}

/* Une passe de veille sur un objet. L'IA trouve où sont les ventes ; le code décide de ce
   qui entre : adresse réellement consultée, même modèle, aucun terme exclu, prix dans la
   fourchette de la signature, et prix écrit tel quel sur la page quand le robot peut la lire.
   Une page lisible qui ne porte pas le prix annoncé est écartée : c'est une erreur de lecture. */
async function veillerObjet(db, env, o) {
  const dn = o.donnees || {}, sig = dn.signature || {};
  const termes = (sig.termes?.length ? sig.termes : dn.requetes || []).filter(Boolean).slice(0, 12);
  const exclusions = (sig.exclusions || []).map(x => String(x).toLowerCase().trim()).filter(Boolean);
  const bilan = { date: maintenant(), recherches: 0, proposees: 0, nouvelles: 0, ecartees: {}, erreur: null };
  const ecarter = r => { bilan.ecartees[r] = (bilan.ecartees[r] || 0) + 1; };
  const nouvelles = [];
  try {
    const r = await claude(env, {
      model: env.MODELE_VEILLE || MODELE_VEILLE, system: SYS_VEILLE, max_tokens: 4000,
      recherches: Math.min(+env.RECHERCHES_VEILLE || 3, 8),
      contenu: `Date du jour : ${aujourdhui()}\nOBJET : ${dn.description || dn.nom || "?"}\n` +
        `marque : ${dn.marque || "?"}, modèle : ${dn.modele || "?"}, référence : ${dn.reference || "?"}, ` +
        `variante : ${dn.variante || "?"}, univers : ${dn.univers || "?"}\n` +
        `signature de veille, termes : ${termes.join(" | ") || dn.nom || "?"}\n` +
        (exclusions.length ? `termes exclus : ${exclusions.join(" | ")}\n` : ""),
    });
    bilan.recherches = r.recherches;
    const ventes = lireJSON(r.texte).ventes || [];
    bilan.proposees = ventes.length;
    const { results: deja } = await db.prepare(`SELECT cle FROM transactions WHERE email = ?`).bind(o.email).all();
    const connues = new Set(deja.map(x => x.cle));
    const retenues = [];
    for (const v of ventes) {
      const prix = nombre(v.prix), k = cleUrl(v.url);
      if (!urlValide(v.url) || !k) { ecarter("adresse invalide"); continue; }
      if (!r.consultees.has(k)) { ecarter("adresse jamais consultée"); continue; }
      if (estPageDeRecherche(v.url)) { ecarter("page de résultats"); continue; }
      if (!["exacte", "modele"].includes(v.correspondance)) { ecarter("autre modèle"); continue; }
      if (!prix || prix <= 0) { ecarter("prix absent"); continue; }
      if (exclusions.some(x => `${v.titre || ""} ${v.url}`.toLowerCase().includes(x))) { ecarter("terme exclu"); continue; }
      const memeDevise = !sig.devise || !v.devise || sig.devise === v.devise;
      if (memeDevise && ((sig.bas && prix < sig.bas) || (sig.haut && prix > sig.haut))) { ecarter("hors fourchette"); continue; }
      if (connues.has(k)) { ecarter("déjà connue"); continue; }
      connues.add(k);
      retenues.push({ ...v, prix });
    }
    for (const v of retenues.slice(0, 8)) {
      let verifie = 0, preuve = `trouvée par la veille du ${aujourdhui()}`;
      try {
        const p = await chargerPage(v.url);
        if (p.statut === 404 || p.statut === 410) { ecarter("page disparue"); continue; }
        if (p.statut < 400) {
          const page = extrairePage(p.html);
          if (page.texte.length > 800) {
            if (!chiffreSurPage(v.prix, page.texte, page.ld, page.metas)) { ecarter("prix absent de la page"); continue; }
            verifie = 1; preuve += ", prix lu sur la page";
          } else preuve += ", page fermée au robot";
        } else preuve += `, page fermée au robot (${p.statut})`;
      } catch { preuve += ", page injoignable"; }
      const t = await ajouterTransaction(db, o.email, { objet_id: o.id, prix: v.prix, devise: devise(v.devise) || "EUR",
        date: date10(v.date_vente), plateforme: v.plateforme, url_source: v.url, libelle: v.titre,
        correspondance: v.correspondance, origine: "veille", preuve, verifie });
      if (t.id) nouvelles.push(t.id);
    }
    bilan.nouvelles = nouvelles.length;
  } catch (e) {
    bilan.erreur = e.message || "échec de la veille";
  }
  const t = maintenant();
  await db.prepare(`INSERT INTO veille (objet_id, email, derniere_veille, derniere_reussite, echecs, bilan, maj_le)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(objet_id) DO UPDATE SET derniere_veille = excluded.derniere_veille,
                      derniere_reussite = COALESCE(excluded.derniere_reussite, veille.derniere_reussite),
                      echecs = CASE WHEN excluded.derniere_reussite IS NULL THEN veille.echecs + 1 ELSE 0 END,
                      bilan = excluded.bilan, maj_le = excluded.maj_le`)
    .bind(o.id, o.email, t, bilan.erreur ? null : t, bilan.erreur ? 1 : 0, JSON.stringify(bilan), t).run();
  if (!bilan.erreur) {
    await apresNouvellesVentes(db, env, o.email, o.id, nouvelles);
    if (nouvelles.length) await noter(db, o.email, "veille",
      `« ${court(dn.nom, 90) || "objet"} » : ${nouvelles.length} nouvelle${nouvelles.length > 1 ? "s" : ""} vente${nouvelles.length > 1 ? "s" : ""} conclue${nouvelles.length > 1 ? "s" : ""} trouvée${nouvelles.length > 1 ? "s" : ""}`, o.id);
  }
  return bilan;
}

/* Le matin : les objets dont le rythme de veille est échu, les plus anciens d'abord, trois à
   la fois, avec un plafond pour que la facture reste prévisible. */
async function veilleQuotidienne(env, email) {
  const db = await base(env);
  const q = db.prepare(`SELECT o.id, o.email, o.donnees, v.derniere_veille FROM objets o
                        LEFT JOIN veille v ON v.objet_id = o.id ${email ? "WHERE o.email = ?" : ""}`);
  const { results } = await (email ? q.bind(email) : q).all();
  const dus = results.map(r => ({ ...r, donnees: lireJSONsur(r.donnees) || {} }))
    .filter(r => {
      const j = RYTHMES[rythmeDe(r.donnees)];
      if (!j) return false;
      return !r.derniere_veille || Date.now() - Date.parse(r.derniere_veille) >= (j - 0.5) * 864e5;
    })
    .sort((a, b) => (a.derniere_veille || "").localeCompare(b.derniere_veille || ""))
    .slice(0, Math.min(+env.LIMITE_VEILLE || 20, 100));
  const bilan = { essais: 0, reussites: 0, nouvelles: 0 };
  const file = [...dus];
  const travailleur = async () => {
    while (file.length) {
      const b = await veillerObjet(db, env, file.shift());
      bilan.essais++;
      if (!b.erreur) bilan.reussites++;
      bilan.nouvelles += b.nouvelles || 0;
    }
  };
  await Promise.all([travailleur(), travailleur(), travailleur()]);
  await noterSante(db, bilan);
  return bilan;
}

/* ---------- 8. la santé de la collecte ---------- */

async function noterSante(db, b) {
  await db.prepare(`INSERT INTO sante (jour, essais, reussites, nouvelles, maj_le) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(jour) DO UPDATE SET essais = sante.essais + excluded.essais,
                      reussites = sante.reussites + excluded.reussites, nouvelles = sante.nouvelles + excluded.nouvelles,
                      maj_le = excluded.maj_le`)
    .bind(aujourdhui(), b.essais, b.reussites, b.nouvelles, maintenant()).run();
}

/* Trois jours de suite où la veille a essayé sans jamais réussir : le prestataire est
   prévenu (bloc 3 du devis). Une seule alerte par série de trois jours. */
async function verifierSante(db, env) {
  const { results } = await db.prepare(`SELECT * FROM sante ORDER BY jour DESC LIMIT 3`).all();
  if (results.length < 3) return false;
  const suivis = results.every((j, i) => i === 0 || Date.parse(results[i - 1].jour) - Date.parse(j.jour) === 864e5);
  if (!suivis || !results.every(j => j.essais > 0 && j.reussites === 0) || results.some(j => j.alerte_envoyee)) return false;
  const ok = await envoyerEmail(env, env.EMAIL_PRESTATAIRE, "la collecte échoue depuis trois jours",
    gabarit(env, "La collecte échoue depuis trois jours", `<p style="font-size:15px;line-height:1.55">Du ${escH(results[2].jour)} au
      ${escH(results[0].jour)}, la veille du matin a tenté ${results.reduce((a, j) => a + j.essais, 0)} passes sans en réussir une seule.
      Causes probables : crédit Anthropic épuisé, clé révoquée, modèle retiré, ou plateforme qui bloque.
      Le détail de chaque objet est dans l'espace, voyant rouge.</p>`));
  if (ok) await db.prepare(`UPDATE sante SET alerte_envoyee = 1 WHERE jour = ?`).bind(results[0].jour).run();
  return ok;
}

async function matin(env) {
  const lots = await tournee(env);
  const veille = await veilleQuotidienne(env);
  const alerte = await verifierSante(await base(env), env);
  return { lots, veille, alerte_prestataire: alerte };
}

/* ---------- proxy IA authentifié ---------- */

/* La recherche de lots se fait depuis la page, comme dans l'atelier, mais derrière la
   porte : seule une session valide peut dépenser des crédits. Le flux de l'API est
   renvoyé tel quel. */
async function proxyIA(req, env, cors) {
  if (!env.ANTHROPIC_API_KEY) throw new Erreur(503, "clé Anthropic absente du worker");
  const c = await req.json();
  if (typeof c.model !== "string" || !/^claude-[a-z0-9.-]+$/.test(c.model)) throw new Erreur(400, "modèle invalide");
  c.max_tokens = Math.min(+c.max_tokens || 4000, 8000);
  if (Array.isArray(c.tools))
    c.tools = c.tools.filter(t => /^web_search/.test(t.type || ""))
                     .map(t => ({ ...t, max_uses: Math.min(+t.max_uses || 4, 10) }));
  const r = await fetch(env.ANTHROPIC_URL || ANTHROPIC, {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(c),
  });
  return new Response(r.body, { status: r.status,
    headers: { "content-type": r.headers.get("content-type") || "application/json", "cache-control": "no-store", ...cors } });
}

/* ---------- l'aiguillage ---------- */

async function lireCorps(req) {
  const t = await req.text();
  if (t.length > 2000000) throw new Erreur(413, "requête trop lourde");
  try { return t ? JSON.parse(t) : {}; } catch { throw new Erreur(400, "JSON invalide"); }
}

async function aiguiller(req, env, cors) {
  const url = new URL(req.url);
  const chemin = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;

  // l'état des réglages, sans rien révéler : sert au diagnostic pendant l'installation
  if (chemin === "/" || chemin === "/sante") {
    let baseOk = false;
    try { await base(env); baseOk = true; } catch {}
    return json({
      service: "Le Collectionnaire, espace", version: VERSION,
      base: baseOk, google: !!env.GOOGLE_CLIENT_ID, google_client_id: env.GOOGLE_CLIENT_ID || null,
      autorises: listeEnv(env.AUTORISES).length, session: !!(env.SESSION_SECRET && env.SESSION_SECRET.length >= 24),
      ia: !!env.ANTHROPIC_API_KEY, origines: listeEnv(env.ORIGINES).length,
      email: !!(env.BREVO_API_KEY && env.EMAIL_EXPEDITEUR), prestataire: !!env.EMAIL_PRESTATAIRE,
      paiement: !!env.STRIPE_WEBHOOK_SECRET,
    }, 200, cors);
  }

  // Stripe appelle ce point sans session : c'est la signature qui fait foi
  if (chemin === "/stripe" && m === "POST") return json(await webhookStripe(req, env), 200, cors);

  if (chemin === "/auth/google" && m === "POST") {
    const c = await lireCorps(req);
    const g = await verifierJetonGoogle(c.credential, env);
    if (!estAutorise(g.email, env)) throw new Erreur(403, `l'adresse ${g.email} n'est pas autorisée dans cet espace`);
    const db = await base(env);
    const t = maintenant();
    await db.prepare(`INSERT INTO utilisateurs (email, nom, photo, fournisseur, cree_le, vu_le) VALUES (?, ?, ?, 'google', ?, ?)
                      ON CONFLICT(email) DO UPDATE SET nom = excluded.nom, photo = excluded.photo, vu_le = excluded.vu_le`)
      .bind(g.email, g.nom, g.photo, t, t).run();
    return json({ jeton: await creerSession(g, env), expire: Math.floor(Date.now() / 1000) + DUREE_SESSION,
                  utilisateur: g }, 200, cors);
  }

  // tout le reste est derrière la porte
  const u = await lireSession(req, env);
  const p = chemin.split("/").filter(Boolean);

  if (chemin === "/moi") return json({ utilisateur: u }, 200, cors);
  if (chemin === "/espace" && m === "GET") return json(await lireEspace(u, env), 200, cors);
  if (chemin === "/ia" && m === "POST") return proxyIA(req, env, cors);
  if (chemin === "/credits" && m === "GET") return json(await lireCredits(await base(env), u, env), 200, cors);
  if (chemin === "/credits/consommer" && m === "POST") {
    const c = await lireCorps(req);
    return json({ ok: true, ...(await debiterCredits(await base(env), u.email, c.action, env, c.detail)) }, 200, cors);
  }
  if (chemin === "/credits/offrir" && m === "POST") {
    if (!estAdmin(u.email, env)) throw new Erreur(403, "réservé à l'administrateur");
    const c = await lireCorps(req), n = Math.round(+c.credits), email = String(c.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !(n > 0 && n <= 1000)) throw new Erreur(400, "adresse ou nombre de crédits invalide");
    return json({ ok: true, ...(await crediter(await base(env), email, n,
      `${plCredits(n)} offerts${c.motif ? ", " + court(String(c.motif), 80) : ""}`, null, env)) }, 200, cors);
  }

  if (p[0] === "objets" && p[1]) {
    if (!p[2] && m === "PUT") return json(await enregistrerObjet(u, p[1], await lireCorps(req), env), 200, cors);
    if (!p[2] && m === "DELETE") return json(await supprimerObjet(u, p[1], env), 200, cors);
    if (p[2] === "photos" && !p[3] && m === "GET") return json(await listerPhotos(u, p[1], env), 200, cors);
    if (p[2] === "photos" && !p[3] && m === "POST") return json(await ajouterPhoto(u, p[1], (await lireCorps(req)).data, env), 200, cors);
    if (p[2] === "photos" && p[3] && m === "DELETE") return json(await supprimerPhoto(u, p[1], p[3], env), 200, cors);
    if (p[2] === "veille" && m === "POST") {
      // veille à la demande sur un objet : même passe que celle du matin
      const db = await base(env);
      const o = await db.prepare(`SELECT id, email, donnees FROM objets WHERE id = ? AND email = ?`).bind(p[1], u.email).first();
      if (!o) throw new Erreur(404, "objet introuvable");
      await verifierSolde(db, u.email, "veille", env);
      const dn = lireJSONsur(o.donnees) || {};
      const bilan = await veillerObjet(db, env, { ...o, donnees: dn });
      await noterSante(db, { essais: 1, reussites: bilan.erreur ? 0 : 1, nouvelles: bilan.nouvelles || 0 });
      const credits = bilan.erreur ? null : await debiterCredits(db, u.email, "veille", env, dn.nom);
      return json({ ok: !bilan.erreur, bilan, credits }, 200, cors);
    }
  }
  if (p[0] === "photos" && p[1]) {
    if (m === "PUT") return json(await enregistrerPhoto(u, p[1], (await lireCorps(req)).data, env), 200, cors);
    if (m === "GET") {
      const db = await base(env);
      const ph = await db.prepare(`SELECT data FROM photos WHERE objet_id = ? AND email = ? ORDER BY rang LIMIT 1`).bind(p[1], u.email).first();
      if (!ph) throw new Erreur(404, "pas de photo");
      return json({ data: ph.data }, 200, cors);
    }
  }
  if (chemin === "/releves" && m === "POST") return json(await ajouterReleve(u, await lireCorps(req), env), 200, cors);
  if (chemin === "/transactions" && m === "POST") return json(await routeTransactions(u, await lireCorps(req), env), 200, cors);
  if (p[0] === "transactions" && p[1] && m === "DELETE") {
    const db = await base(env);
    await db.prepare(`DELETE FROM transactions WHERE id = ? AND email = ?`).bind(p[1], u.email).run();
    return json({ ok: true }, 200, cors);
  }
  if (p[0] === "lots" && p[1]) {
    if (p[2] === "relire" && m === "POST") {
      const db = await base(env);
      const lot = await db.prepare(`SELECT * FROM lots WHERE id = ? AND email = ?`).bind(p[1], u.email).first();
      if (!lot) throw new Erreur(404, "lot introuvable");
      return json({ ok: true, lot: await relireLot(db, lot, env) }, 200, cors);
    }
    if (p[2] === "resultat" && m === "POST") return json(await saisirResultat(u, p[1], await lireCorps(req), env), 200, cors);
    if (!p[2] && m === "PUT") return json(await enregistrerLot(u, p[1], await lireCorps(req), env), 200, cors);
    if (!p[2] && m === "DELETE") return json(await supprimerLot(u, p[1], env), 200, cors);
  }
  if (chemin === "/tournee" && m === "POST") return json({ ok: true, ...(await tournee(env, u.email)) }, 200, cors);
  if (chemin === "/veille" && m === "POST") return json({ ok: true, ...(await veilleQuotidienne(env, u.email)) }, 200, cors);

  throw new Erreur(404, "route inconnue");
}

export default {
  async fetch(req, env) {
    const cors = enTetesCors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (origineRefusee(req, env)) throw new Erreur(403, "page d'origine non autorisée (ORIGINES)");
      return await aiguiller(req, env, cors);
    } catch (e) {
      const statut = e instanceof Erreur ? e.statut : 500;
      if (statut === 500) console.error(e);
      return json({ erreur: e instanceof Erreur ? e.message : "erreur interne du worker" }, statut, cors);
    }
  },

  async scheduled(evenement, env, ctx) {
    ctx.waitUntil(matin(env).then(b => console.log("matin", JSON.stringify(b))));
  },
};
