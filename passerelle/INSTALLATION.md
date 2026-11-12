# Espace collectionneur : installation sans Terminal

Trois fichiers font l'espace. `docs/espace.html` est la page, servie par GitHub Pages comme
l'atelier. `passerelle/espace-worker.js` est le coffre : un worker Cloudflare qui vérifie la
connexion Google, garde la collection dans une base D1, veille chaque matin sur les ventes
conclues, cote, détecte les anomalies, les explique et prévient par e-mail.
`docs/atelier.html` gagne le bouton « ranger dans mon espace » en bas de la synthèse.

Tout se règle dans quatre tableaux de bord : Google Cloud, Cloudflare, Brevo, GitHub. Compter
trente minutes. La page `espace.html` dit elle-même ce qui manque tant que ce n'est pas fini.

## 1. Google Cloud : l'identifiant de connexion (5 min)

1. Ouvrir console.cloud.google.com, créer un projet nommé « Le Collectionnaire ».
2. Menu « Google Auth Platform », puis « Branding » : nom de l'application « Le Collectionnaire »,
   adresse de support. Audience : « Externe ».
3. « Audience » : cliquer sur « Publier l'application ». Seuls l'adresse e-mail et le nom sont
   demandés, aucune validation Google n'est nécessaire. La vraie porte est la liste AUTORISES.
4. « Clients », « Créer un client » : type « Application Web », nom « Espace ».
   « Origines JavaScript autorisées » : exactement `https://edouard-cmd.github.io`.
   Aucune URI de redirection.
5. Copier l'« ID client » (il finit par `.apps.googleusercontent.com`).

## 2. Brevo : les e-mails d'alerte (5 min, facultatif mais prévu au devis)

1. Créer un compte gratuit sur brevo.com (300 e-mails par jour, largement assez).
2. « Expéditeurs, domaines et IP dédiées », « Expéditeurs », ajouter l'adresse qui enverra les
   alertes et la valider par le lien reçu. Pour une adresse en @cobound.fr, authentifier aussi
   le domaine (onglet « Domaines ») : les alertes n'arriveront pas en indésirables.
3. « SMTP et API », « Clés API », générer une clé.

Sans Brevo, tout marche, mais les alertes restent dans l'espace et son journal.

## 3. Cloudflare : le coffre (15 min)

1. Passer le compte en « Workers Paid » (5 $ par mois) : « Workers & Pages », « Plans ».
   L'offre gratuite plafonne chaque exécution à 10 millisecondes de calcul et 50 appels
   sortants ; la veille du matin lit des dizaines de pages et dépasse les deux. Sans cette
   offre, la connexion et la collection marchent, la veille échoue.
2. « Storage & Databases », « D1 SQL Database », « Create » : nom `collectionnaire`.
   Les tables se créent seules au premier appel.
3. « Workers & Pages », « Create », « Worker », modèle « Hello World », nom `collector-espace`
   (l'adresse devient `https://collector-espace.edouard-e8b.workers.dev`, déjà inscrite dans la
   page). « Deploy », puis « Edit code » : tout remplacer par le contenu de
   `passerelle/espace-worker.js`, puis « Deploy ».
4. « Settings », « Bindings », « Add » : « D1 database », nom de variable `BASE`, base `collectionnaire`.
5. « Settings », « Variables and Secrets » :

   | nom | type | valeur |
   |---|---|---|
   | `GOOGLE_CLIENT_ID` | Text | l'ID client de l'étape 1 |
   | `AUTORISES` | Text | les adresses Google autorisées, séparées par des virgules : celle d'Emilia, `edouard@cobound.fr` |
   | `ORIGINES` | Text | `https://edouard-cmd.github.io` |
   | `SESSION_SECRET` | Secret | une suite aléatoire d'au moins 40 caractères, tirée du gestionnaire de mots de passe |
   | `ANTHROPIC_API_KEY` | Secret | la même clé que la passerelle de l'atelier |
   | `BREVO_API_KEY` | Secret | la clé Brevo de l'étape 2 |
   | `EMAIL_EXPEDITEUR` | Text | l'adresse validée chez Brevo |
   | `EMAIL_PRESTATAIRE` | Text | `edouard@cobound.fr`, prévenue si la collecte échoue trois jours de suite |

   Puis « Deploy ». Réglages facultatifs, à laisser vides au départ : `LIMITE_VEILLE` (20 objets
   par matin), `RECHERCHES_VEILLE` (3 recherches par objet), `LIMITE_TOURNEE` (30 lots par matin),
   `MODELE_VEILLE`, `MODELE_EXPLICATION`, `MODELE_LECTURE`, `URL_ESPACE`.
6. « Settings », « Trigger events », « Cron Triggers », « Add » : `17 6 * * *`
   (chaque matin à 7 h 17, heure de Paris en hiver).
7. Vérifier : `https://collector-espace.edouard-e8b.workers.dev/sante`. Chaque ligne doit être à
   `true` ou à un nombre supérieur à zéro.

## 4. GitHub : la page (2 min)

« Add file », « Upload files », glisser les dossiers `docs` et `passerelle` fournis :
`espace.html` s'ajoute, `atelier.html` est remplacé. GitHub Pages publie en une minute.

## 5. Essai

Ouvrir `https://edouard-cmd.github.io/collector-intelligence/docs/espace.html`, se connecter avec
Google. Dans l'atelier, estimer un objet et cliquer « ranger dans mon espace ». Dans sa fiche,
« lancer la veille maintenant » : les nouvelles ventes conclues arrivent, la cote se met à jour.
Le lendemain matin, la veille passe seule ; le voyant de l'objet et la ligne de santé sous le
tableau de bord le confirment. Trois jours de veille réussie, c'est le livrable du bloc 3.

## Ce que le devis promet, et où c'est

| Bloc | Promesse | Où |
|---|---|---|
| 2 | Photo depuis le mobile, sans installation | atelier, puis photos multiples dans la fiche |
| 2 | Pré-remplissage IA : catégorie, sous-catégorie, licence, marque, référence, variante, état | atelier, champs transmis et modifiables dans l'espace |
| 2 | Signature de veille modifiable (termes, exclusions, fourchette) | « modifier la fiche et la veille » |
| 2 | Notes datées, photos multiples, provenance, tags | fiche de l'objet |
| 2 | Achat : prix, date, vendeur, plateforme, commentaire | fiche de l'objet |
| 2 | Aide à l'authenticité avec checklist | avis de l'atelier, checklist cochable dans la fiche |
| 3 | Reprise des ventes conclues à la création | bouton « ranger dans mon espace » |
| 3 | Collecte quotidienne automatique, ventes finalisées seules | veille du matin, worker |
| 3 | Rattachement automatique à la signature | veille du matin |
| 3 | Voyants de santé de la source | pastille de chaque objet, ligne de santé du tableau de bord |
| 3 | Alerte au prestataire après trois jours d'échec | e-mail à `EMAIL_PRESTATAIRE` |
| 4 | Moyenne, médiane, tendance, volatilité | fiche de l'objet |
| 4 | Écart prix payé et valeur, qualification sous-coté, correctement coté, surcoté | carte et fiche |
| 4 | Courbe de valeur et historique | graphique de la fiche |
| 4 | Anomalie au rythme de l'objet, pas à un seuil absolu | worker, à 2,5 fois l'écart habituel de ses prix |
| 4 | Projection de tendance | fiche et graphique, seulement si la tendance est nette |
| 4 | Cote seulement à partir de trois ventes conclues sur douze mois, sinon « non cotable » | worker |
| 5 | Explication seulement en cas d'anomalie, trois hypothèses avec leur confiance | worker, fiche, e-mail |
| 5 | E-mail : objet, ampleur, explication retenue | Brevo |
| 5 | Paliers +50 %, +100 %, -25 % | worker, e-mail |
| 5 | Tableau de bord : investi, valeur, plus-value, rentabilité, meilleures et moins bonnes performances, progression, stagnation, à surveiller | haut de l'espace |

En plus du devis : la connexion Google, le suivi des enchères (lots relus chaque matin,
adjudications versées dans l'historique) et l'onglet « je guette ».

## Ce qui protège quoi

La page est publique, comme tout le dépôt ; elle ne contient aucune donnée. Les données sont
dans la base D1, que seul le worker lit. Le worker n'ouvre que sur une session qu'il a signée
avec `SESSION_SECRET`, et ne la signe qu'après avoir vérifié, avec les clés publiques de Google,
un jeton d'identité destiné à notre ID client, pour une adresse vérifiée présente dans
`AUTORISES`. Chaque adresse ne voit que ses objets. Retirer une adresse ferme la porte aussitôt ;
changer `SESSION_SECRET` déconnecte tout le monde.

## Règle de la donnée, inchangée

Une vente sans adresse de page n'entre pas dans la base. La veille ne garde qu'une adresse que
la recherche a réellement consultée, du même modèle, sans terme exclu, dans la fourchette, et
dont le prix est écrit tel quel sur la page quand le robot peut la lire ; une page lisible qui
ne porte pas ce prix est écartée. La cote, la tendance, la volatilité et la projection sont des
calculs du code. L'IA trouve où chercher et explique ; elle ne produit aucun chiffre de valeur,
et une hypothèse dont la source n'a pas été consultée est plafonnée à 40 % de confiance.

## Coûts mensuels, pour 20 objets surveillés chaque matin

Cloudflare Workers Paid : 5 $. Anthropic : la veille d'un objet coûte autour de 0,04 € (trois
recherches, Haiku), soit environ 25 € par mois à ce rythme ; passer les objets peu chers en
veille hebdomadaire divise ce poste. Une explication d'anomalie coûte environ 0,15 € et ne part
que sur anomalie. Brevo, D1 : gratuits à cette échelle.

## Limite connue

Certaines plateformes chargent leurs pages en JavaScript ou bloquent les robots. Une vente
trouvée sur ces pages entre alors avec la mention « page fermée au robot » au lieu de « prix
relu sur la page », et la fiche dit combien de prix ont été relus. Un lot d'enchères dans ce cas
reste en « résultat attendu » et se saisit à la main.

## Passation sur les comptes d'Emilia

Refaire les étapes 1 à 3 sur ses comptes, avant qu'elle ne saisisse ses vrais objets. Trois
réglages suivent l'adresse de son site GitHub et de son worker : l'origine autorisée chez
Google, la variable `ORIGINES`, et l'adresse du coffre dans `docs/espace.html` (la constante
`ESPACE` et la ligne `Content-Security-Policy` en haut du fichier, qui doivent porter la même
adresse).
