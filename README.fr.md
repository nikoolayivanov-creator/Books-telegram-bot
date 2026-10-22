# flibusta-telegram-bot

[RU](README.md) · [EN](README.en.md) · [中文](README.zh.md) · [Español](README.es.md) · **Français**

Bot Telegram pour chercher et télécharger des livres sur [Flibusta](https://flibusta.is).

Le LLM n'a ici qu'un rôle : transformer une requête en langage libre en une structure « auteur + titre » pour que la recherche OPDS de Flibusta tombe juste. La recherche, le classement et le téléchargement sont déterministes et se font sans LLM. En parallèle de l'analyse LLM tourne un découpage déterministe : les deux pools de candidats sont fusionnés et chaque livre entre dans les résultats avec la meilleure des deux notes.

## Fonctionnalités

- Recherche en texte libre (« conan doyle sherlock », « wite fang london ») : le LLM en extrait l'auteur et le titre, et le découpage assure la relève en parallèle.
- Liste classée avec formats, taille, nombre de téléchargements et traducteur ; 3 pages de 5 livres.
- Fiche du livre avec description et boutons de formats (fb2, epub, mobi, pdf, txt, rtf, html).
- Téléchargement avec décompression : Flibusta livre les formats texte dans un zip, et le bot en extrait le fichier interne pour que votre liseuse l'ouvre.
- Diffusion du déroulement de la recherche dans le chat : « j'analyse », « je cherche », « je feuillette la page 3/10 », « je compare ». L'utilisateur voit ce que fait le bot au lieu d'attendre dans le silence.
- Limites quotidiennes sur une fenêtre glissante de 24 h : 10 téléchargements, 50 recherches, plus une liste d'ID illimités.
- Statistiques dans SQLite (`/stats`), cache de recherche en mémoire pendant 6 heures.
- Journal des requêtes et des livres choisis en JSONL (l'id telegram est haché en sha256) — pour analyser vous-même la qualité de la recherche.

## Comment le LLM est utilisé

À chaque recherche hors cache, un seul appel à `parseQuery`, qui convertit le texte en `{authors, title, series, genre}`. Ensuite, le LLM n'intervient plus.

La recherche suit deux chemins à la fois :

1. **Analyse LLM** — la structure issue de `parseQuery` part dans la recherche OPDS de Flibusta, par auteur et par titre.
2. **Découpage déterministe** (`splitSearchBooks`) — la requête est fragmentée en variantes « auteur + titre », chacune vérifiée par une recherche, sans LLM.

Les pools de candidats sont fusionnés, chaque livre est noté selon les deux analyses, et c'est le maximum des deux qui l'emporte. Le découpage couvre les cas où le LLM se plante (recherche par auteur seul, requêtes réelles sales) et prend le relais si le fournisseur tombe : quand le LLM est indisponible, la recherche passe en mode dégradé (la requête entière est traitée comme un titre) et le découpage continue de fonctionner. Le raisonnement du LLM est désactivé pour gagner en vitesse ; les requêtes en cache ne déclenchent aucun appel.

Mesure sur 200 requêtes (100 livres, chacun avec une formulation propre et une sale) : l'union du LLM et du découpage donne 80 % de résultats exacts dans le top 3 sur les requêtes propres et 75 % sur les sales ; sans LLM, la recherche des requêtes sales s'effondre à 17 % — le découpage ne sait pas extraire l'auteur et le titre d'une phrase fautive et bourrée de bruit.

## Prérequis

- Node 20 (Docker est le plus simple).
- Un token de bot Telegram obtenu auprès de @BotFather.
- Une clé API d'un fournisseur LLM compatible OpenAI (bothub.chat, OpenAI, etc.).
- Un serveur ou un VPS avec Docker.

## Configuration

```bash
cp .env.example .env
```

| Variable | Oblig. | Par défaut | Description |
|---|---|---|---|
| `BOT_TOKEN` | oui | - | token de @BotFather |
| `ADMIN_IDS` | oui | - | IDs Telegram des administrateurs, séparés par des virgules ; ils voient `/stats` |
| `LLM_API_KEY` | oui | - | clé du fournisseur LLM |
| `LLM_BASE` | oui | - | endpoint compatible OpenAI, p. ex. `https://openai.bothub.chat/v1` |
| `MODEL` | oui | - | modèle, p. ex. `gemini-2.5-flash` |
| `FLIBUSTA_BASE` | oui | - | miroir de Flibusta, p. ex. `https://flibusta.is` |
| `FLIBUSTA_FALLBACK_BASE` | non | - | miroir de secours |
| `ALLOWED_IDS` | non | (vide) | whitelist ; vide signifie que le bot est public |
| `UNLIMITED_IDS` | non | - | IDs sans limites quotidiennes |
| `DOWNLOAD_DAILY_LIMIT` | non | 10 | téléchargements par 24 h |
| `SEARCH_DAILY_LIMIT` | non | 50 | recherches par 24 h |
| `RATE_LIMIT_PER_MIN` | non | 20 | requêtes par minute et par utilisateur |
| `MAX_QUERY_LEN` | non | 100 | longueur maximale de la requête, en caractères |
| `SEARCH_CACHE_TTL_SEC` | non | 21600 | TTL du cache de recherche |
| `SEARCH_CACHE_MAX` | non | 2000 | entrées dans le cache de recherche |
| `USAGE_LOG_PATH` | non | `/logs/usage.jsonl` | chemin du journal des requêtes et des choix (l'id est haché) |
| `LOG_TTL_DAYS` | non | - | durée de conservation des événements dans SQLite, en jours |

## Lancement (Docker)

```bash
docker compose up -d --build
docker compose logs -f
```

## Déploiement sur un VPS

Dans `deploy.sh`, renseignez `VPS=user@host`, puis :

```bash
./deploy.sh
```

Le script synchronise le code par ssh, construit l'image et redémarre le conteneur.

## Développement

```bash
npm install
npm test
npm run build && npm start
```

## Architecture

- `bot.ts` — les handlers grammY en long polling, non bloquants : le travail lourd passe en arrière-plan et la file d'updates ne s'accumule pas. La logique de diffusion s'y trouve aussi : les événements de progression sont condensés en textes de statut avec throttle, pour ne pas inonder le chat.
- `search/orchestrator.ts` — le cœur de la recherche : cache → analyse LLM → fusion du pool LLM et du découpage → classement déterministe → top-N. Le classement note la correspondance du titre et de l'auteur, avec rattrapage des fautes de frappe par Levenshtein ; à note égale, l'édition la plus populaire passe devant.
- `search/llm.ts` — le client LLM (compatible OpenAI), avec une seule méthode : `parseQuery`.
- `search/flibusta.ts` — une enveloppe autour du paquet npm `flibusta` : recherche OPDS, pagination de la bibliographie de l'auteur (les auteurs prolifiques ne tiennent pas sur la première page), choix parmi les homonymes par popularité, timeout sur chaque appel réseau.
- `download.ts` — téléchargement en tmpfs et extraction de l'enveloppe zip.
- `status.ts` — les textes des messages de statut : phases de la recherche, progression du téléchargement.
- `usage-log.ts` — journal JSONL des requêtes et des livres choisis (l'id Telegram est haché en sha256, le contenu n'est pas conservé).
- `db.ts` et `analytics.ts` — le journal d'événements dans SQLite et les limites quotidiennes.

## Aspects juridiques

Les livres sur Flibusta ont un statut de droits d'auteur variable selon la juridiction. Vérifiez que vous avez le droit de télécharger ce contenu dans la vôtre. Le fournisseur LLM et le modèle se configurent librement : respectez les conditions d'utilisation du fournisseur choisi.

## Licence

MIT © vonavikon
