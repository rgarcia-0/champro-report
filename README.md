# CHAMPRO Sample Report — Node.js

Dashboard de órdenes de producción para Ransiel Garcia.

## Stack
- **Node.js + Express** — API server + static files
- **PostgreSQL** — Base de datos
- **Puppeteer + Cheerio** — Scraper del CPA
- **Google Sheets API** — Sync de órdenes
- **Render.com** — Hosting gratuito

---

## Setup Local (para desarrollo)

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configurar variables de entorno
```bash
cp .env.example .env
# Edita .env con tus valores
```

### 3. Crear la base de datos (PostgreSQL local)
```bash
# Asegúrate de tener PostgreSQL corriendo
createdb champro
node src/db/migrate.js
```

### 4. Configurar Google Sheets

**Opción A — Service Account (recomendado para producción):**
1. Ve a [Google Cloud Console](https://console.cloud.google.com)
2. Crea un proyecto → activa "Google Sheets API"
3. Ve a "IAM & Admin" → "Service Accounts" → crea una cuenta
4. Descarga el JSON de la cuenta
5. Comparte el Google Sheet con el email de la service account (vista)
6. Copia el JSON minificado a `GOOGLE_SERVICE_ACCOUNT_JSON` en `.env`

### 5. Correr el servidor
```bash
npm run dev    # con hot-reload
# o
npm start      # producción
```

Visita: http://localhost:3000

---

## Deploy en Render.com (GRATUITO)

### Paso 1: Subir el código a GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/champro-report.git
git push -u origin main
```

### Paso 2: Crear cuenta en Render
- Ve a [render.com](https://render.com) → Sign up (gratis, sin tarjeta)

### Paso 3: Crear el servicio
1. Dashboard → **New** → **Blueprint** (usa el render.yaml incluido)
2. Conecta tu repositorio de GitHub
3. Render detecta el `render.yaml` automáticamente
4. Crea **Web Service** + **PostgreSQL** juntos

### Paso 4: Configurar variables secretas
En el dashboard de Render, ve al servicio → **Environment**:
- `CPA_USER` = `rgarcia1`
- `CPA_PASS` = `XkK9Zn^KI9*6@H`
- `GOOGLE_SERVICE_ACCOUNT_JSON` = (pega el JSON minificado)

### Paso 5: Inicializar la base de datos
En Render → tu servicio → **Shell**:
```bash
node src/db/migrate.js
node src/sync.js    # sync inicial desde Google Sheets
```

### Paso 6: Acceder a tu web
Render te da un URL tipo: `https://champro-sample-report.onrender.com`

Comparte ese link con tu equipo — no necesita login.

---

## Comandos útiles

```bash
# Sync manual desde Google Sheets
node src/sync.js

# Scraper manual del CPA (20 órdenes)
node src/scraper.js

# Ver estado de la DB
node -e "require('./src/db').getOrderStats().then(console.log)"
```

## Limitaciones del free tier de Render

- **Web Service**: se "duerme" tras 15 min sin tráfico. Al abrir la web tarda ~30s en despertar.
- **PostgreSQL**: dura 90 días. Después hay que crear uno nuevo y correr `node src/db/migrate.js` + `node src/sync.js` de nuevo.
- **Para evitar el sleep**: abre la web una vez al día o usa [UptimeRobot](https://uptimerobot.com) gratis para hacer ping cada 5 minutos.

## Renovar PostgreSQL (cada 90 días)
1. Render Dashboard → tu DB → **Delete**
2. Render Dashboard → **New** → **PostgreSQL** (mismo nombre)
3. Actualiza `DATABASE_URL` en el Web Service
4. Corre: `node src/db/migrate.js && node src/sync.js`
