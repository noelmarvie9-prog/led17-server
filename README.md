# LeD17 Casino Live — Serveur Backend

## Ce que fait ce serveur
- Gère les comptes utilisateurs (inscription / connexion)
- Stocke les points de chaque viewer dans MongoDB
- Système de raffle en temps réel (WebSocket)
- Bot DLive qui écoute le chat :
  - `!raffle5000` → lance une raffle de 5000 pts (admin seulement)
  - `!join` → les viewers rejoignent la raffle
  - Tirage automatique après 2 minutes
  - Points crédités automatiquement au gagnant

---

## Déploiement sur Railway

### Étape 1 — MongoDB Atlas
1. Va sur https://mongodb.com/atlas → "Try Free"
2. Crée un cluster gratuit (M0)
3. Crée un utilisateur DB (Database Access)
4. Autorise toutes les IPs (Network Access → 0.0.0.0/0)
5. Copie ton URI de connexion : `mongodb+srv://user:pass@cluster.mongodb.net/led17`

### Étape 2 — GitHub
1. Va sur https://github.com → crée un compte
2. Crée un nouveau repository (ex: `led17-server`)
3. Upload les fichiers `server.js`, `package.json`

### Étape 3 — Railway
1. Va sur https://railway.app → "Login with GitHub"
2. "New Project" → "Deploy from GitHub repo"
3. Sélectionne ton repo `led17-server`
4. Va dans "Variables" et ajoute :
   - `MONGODB_URI` → ton URI MongoDB Atlas
   - `JWT_SECRET` → n'importe quelle chaîne secrète longue (ex: `led17superSecret2024xyz`)
   - `DLIVE_USERNAME` → `led17` (ton pseudo DLive en minuscules)
   - `ADMIN_USERS` → `led17` (les admins qui peuvent lancer !raffle)
5. Railway déploie automatiquement et te donne une URL (ex: `led17-server.up.railway.app`)

### Étape 4 — Connecter le site HTML
Dans ton fichier HTML, remplace :
```
const API_URL = 'https://TON-SERVEUR.up.railway.app';
```

---

## Commandes chat DLive
| Commande | Qui | Action |
|----------|-----|--------|
| `!raffle5000` | Admin seulement | Lance une raffle de 5000 pts |
| `!raffle500` | Admin seulement | Lance une raffle de 500 pts |
| `!join` | Tout le monde | Rejoindre la raffle active |
