# Hosting the VERTIGO harness

> **LIVE versus CANDIDATE.** LIVE reste six outils / writer Notion natif. Le candidat PDEC-018 à cinq outils / writer backend est **BUILD TARGET — NOT ADOPTED**. Le bloc W7.6 ci-dessous prépare le rollback en local seulement ; les instructions historiques suivantes ne sont pas un GO VPS/déploiement/restauration. Canon : `docs/START_HERE.md`, plan `PV-WRITE-001` révision18 / L-SCHED-1.

## W7.6 — préparation locale du rollback, opérateur uniquement

Le collaborateur n'installe ni serveur, ni PostgreSQL, ni outil de sauvegarde. Il utilise le plugin
approuvé dans son ChatGPT. L'opérateur prépare les sauvegardes côté backend ; aucun terminal ou
secret Notion ne lui est demandé. Ce checkpoint est **TECHNICAL_READY au plus**, pas GW7.6 PASS.

Trois artefacts distincts sont nécessaires, et ne doivent pas être confondus :

- **Code committé** : une archive Git du commit exact, avec les fichiers restaurés comparés aux
  objets Git. Elle récupère une version locale ; elle ne prouve pas que cette version est servie.
- **Paquet plugin conservé** : garder le ZIP de rollback et son SHA-256. Sa version de manifeste
  n'est pas une preuve de la version effectivement installée dans ChatGPT. Ne jamais distribuer
  une archive qui contient le token d'une personne ; elle reste privée côté opérateur.
- **Store PostgreSQL** : `backup.sh` existant fournit un dump custom vérifié par restauration dans
  une base jetable. Comparer aussi le journal et toutes les tables/champs (comptes et empreintes des
  lignes), pas seulement trois compteurs. Conserver les dumps700/600 et ne pas imprimer les payloads.

Le reçu W7.6 fixe les empreintes et le chemin des artefacts, la version locale, la base/host de test,
les comptes/fingerprints et le nettoyage. L'oracle local utilise uniquement127.0.0.1:5432 : il lit le
store de test `vertigo_w36_local`, en crée un clone privé, sauvegarde ce clone puis restaure dans une
autre base jetable propre. Il ne modifie pas le store initial et ne restaure jamais sur une base LIVE.
Les bases créées par l'oracle sont supprimées à la fin ; le dump et les archives restent privés.
Les commandes PostgreSQL exigent les outils locaux de l'opérateur, pas la machine du collaborateur.

Le mode de test existant, **sur une base de test et un répertoire temporaire déjà identifiés** :

```sh
PGHOST=127.0.0.1 PGHOSTADDR=127.0.0.1 PGPORT=5432 \
  VERTIGO_PG_LOCAL=1 VERTIGO_PG_DB=<base-de-test> \
  VERTIGO_BACKUP_DIR=<repertoire-prive> bash deploy/backup.sh
PGHOST=127.0.0.1 PGHOSTADDR=127.0.0.1 PGPORT=5432 \
  VERTIGO_PG_LOCAL=1 bash deploy/backup.sh --check <dump-prive>
```

Ne pas copier cette commande vers le VPS ni y installer le cron sans GO distinct. L'oracle force
la connexion locale et n'utilise aucun accès Docker/VPS. Il refuse de qualifier de récupérables des
bytes ou tables différents ; une simple réussite de `pg_restore` n'est pas la comparaison des données.

**Ce que ces artefacts ne récupèrent pas.** Les configs/credentials locales non versionnées doivent
être protégées séparément côté opérateur, jamais dans le paquet partagé ou un reçu. L'archive Git et
le dump PostgreSQL ne restaurent pas les pages métier Notion, les gouverning pins, les Gmail/Calendar
ni les effets déjà réalisés hors backend. Les dumps sur le même disque ne survivent pas à la perte
du serveur ; la copie hors machine demeure la tâche ultérieure déjà identifiée, pas ajoutée ici.

**Rollback opérationnel, après autorisation seulement.** Avant toute intervention : suspendre les
writers/exécuteurs concernés et conserver le dernier état ; choisir explicitement la révision et
vérifier la compatibilité code/schéma/données. Un dump d'une révision récente n'est pas réputé
compatible avec un ancien binaire ; les migrations idempotentes ne sont pas un oracle de downgrade.
Ne jamais effacer l'historique/les preuves pour faire correspondre les versions ni repinner Notion
automatiquement. La restauration d'un ancien store ne permet **jamais** de rejouer un envoi ou
d'attester un état externe : confronter les opérations concernées aux sources compétentes avant
reprise, sous les gardes existantes. Aucune permission d'envoi durable depuis un checkpoint ancien.

La recette finale doit encore attester le paquet/révision/config **réellement servis**, l'auth par
membre, le recovery après pilote et les conditions existantes (Gmail/Calendar/META, télémétrie
raccordée, VPS≤10USD/mois). Pas de promesse de latence, coût ou readiness à partir de cette preuve locale.

## Référence LIVE / ingénierie historique — pas autorisation d'exécution

Les sections ci-dessous conservent le parcours six outils / writer natif, ses chemins et observations
datées. Elles ne sont pas le parcours collaborateur candidat, ni une preuve des tarifs/menus actuels.

Written for whoever operates the server — today Valentin, tomorrow whoever replaces him.

## Why this exists

The harness ran on a laptop. A sleeping laptop removes the entire governance layer, and ChatGPT does not stop:
it answers from the generic Notion connector and presents the result as if the system of record had been read.
That happened twice on 2026-09-22 and is recorded as ticket `PV-FAILOPEN-001`. Nothing in the plugin can fix it,
because a connector that does not answer puts no instruction in the model's context. The only real fix is an
endpoint that is always up.

## Choosing the machine

It must never sleep and never scale to zero. That single requirement rules out most free tiers.

| Option | Cost | Verdict |
| --- | --- | --- |
| Oracle Cloud **Always Free** (ARM Ampere, 4 vCPU / 24 GB) | free, no time limit | **Recommended.** Genuinely free forever and far larger than needed. Capacity can be scarce in some regions; retry or pick another region. |
| Google Cloud **e2-micro** free tier (1 vCPU / 1 GB, US regions) | free, no time limit | Good fallback. Small but sufficient — the harness is a read-only MCP server with three dependencies. |
| Hetzner CX22 | about €4 / month | Choose this if the free-tier signup friction is not worth an hour. Boringly reliable. |
| Render / Railway / Fly free plans | free | **Avoid.** They idle or scale to zero, which reproduces the exact failure being fixed. |

Minimum: 1 vCPU, 1 GB RAM, 10 GB disk, a public IPv4, Docker installed, ports 80 and 443 open.

## One-time setup

1. **DNS first.** Point a subdomain you control, for example `vertigo-os.studiovertigo.io`, at the server's IP.
   Caddy cannot obtain a certificate before the record resolves.
2. **Clone** the repository on the server.
3. **Copy the private configuration** from the laptop — it is git-ignored and must never be committed.
   Create `config/runtime-state/` on the server with mode0700. Keep only the Sales registry in that
   writable directory; principals and credential hashes remain in the read-only `config/` mount:
   ```
   scp config/principals.local.json config/http-tokens.local.json \
       user@server:/path/to/repo/config/
   scp config/sales-runtimes.local.json \
       user@server:/path/to/repo/config/runtime-state/
   ```
   Existing server: back up the old Sales file privately, then move it byte-exact to
   `config/runtime-state/sales-runtimes.local.json`, preserving owner/mode. Do not leave an old active
   `config/sales-runtimes.local.json`: deployment refuses two competing paths. No assignment is edited
   during migration; the installer still needs its complete FINAL proof before activation.
   Keeping `http-tokens.local.json` identical is what keeps the path token in the connector URL unchanged: only
   the hostname moves, so the connector is reconfigured once and never again.
4. **Fill `deploy/.env`** from `deploy/.env.example`. The Notion token must be read-only and least-privilege:
   the harness never writes to Notion, it renders instructions the native Notion app executes.
5. **Carry the backend history over** (optional but recommended — receipts are evidence):
   ```
   # on the laptop
   pg_dump -Fc vertigo_harness > /tmp/vertigo.dump
   scp /tmp/vertigo.dump user@server:/tmp/
   # on the server, after the first start
   docker compose cp /tmp/vertigo.dump db:/tmp/
   docker compose exec db pg_restore -U vertigo -d vertigo_harness --clean --if-exists /tmp/vertigo.dump
   ```
   Skipping this starts from an empty journal. Durable business state lives in Notion and is unaffected; what
   is lost is the backend's own plan, receipt and event history (today: 30 plans, 37 receipts, 286 events).
6. **Deploy**: `deploy/deploy.sh`

## Redeploying

Commit, push, then on the server:

```
git pull && deploy/deploy.sh
```

The script refuses to run on a dirty tree, because the endpoint stamps a revision into every `initialize`
response and that stamp must describe exactly what it serves.

## Verifying — before handing any test to a seller

A redeploy is not a test, and a green server is not a reachable one. Two checks, both mandatory:

1. The endpoint answers: `deploy.sh` does this and prints the served revision.
2. **The connector actually reached it.** After the seller's first message, look for `ua=openai-mcp` in the
   logs within the test window:
   ```
   docker compose logs harness | grep openai-mcp | tail -5
   ```
   Zero lines means the chat never reached the backend and its transcript says nothing about the product. A
   full test came back on 2026-09-22 with a confident, entirely fabricated answer while the backend had
   received nothing since the previous day.

An `initialize` handshake appears as a `POST … -> 202`. ChatGPT caches the skill text and tool descriptions
from its last initialize, so a change to either is invisible until a new handshake appears.

## Rolling back

```
git checkout <previous-revision> && deploy/deploy.sh
```

Contract lines are not rolled back this way: re-pinning a contract version is a Manifest edit in Notion, written
last, and it is the seller's or owner's action.

## Backups (PT-OPS-001)

The Postgres store holds what the harness itself proved: plans, the write journal, receipts and the audit log.
Notion stays the business truth, but losing this store loses the evidence of every verified transaction and the
executor's record of what it already sent. It is dumped daily, and a dump is only trusted once it has been restored.

**Install once, on the server, during an authorized deployment** (the cron file is a template: the repository
path is injected at install time, nothing is assumed):

```
sed "s#__VERTIGO_REPO__#$(pwd)#" deploy/backup.cron > /etc/cron.d/vertigo-harness-backup && chmod 644 /etc/cron.d/vertigo-harness-backup
deploy/backup.sh                      # a first dump, now
```

Every day at 03:15 UTC `deploy/backup.sh` writes `vertigo_harness-<UTC stamp>.dump` (`pg_dump -Fc`) to
`/var/backups/vertigo-harness` (outside the repository, mode 700, files 600). A dump is written aside, checked as a
readable archive, then renamed, so a file that exists is complete. Dumps older than 14 days are deleted. The log is
`/var/log/vertigo-harness-backup.log`.

**Prove a dump restores** — once after installing, then after any change to the store:

```
deploy/backup.sh --check /var/backups/vertigo-harness/<file>.dump
```

It restores the file into a throwaway database, prints the number of plans, receipts and events (and whether the
write journal table exists), then drops the throwaway database. Compare the counts with the live store; they must
match the moment of the dump.

**What this protects, and what it does not.** The dumps live on the server's own disk. They restore the database
after a bad migration, a corrupted volume or a container rebuilt from scratch, as long as the server's storage is
still there. They do **not** survive the loss of the machine itself: an off-host copy (object storage, another
host) is a separate, later task, not part of this one.

**Restore** (the database or its container is lost, the server is not): start the stack on an empty volume, then

```
cd deploy && docker compose exec -T db pg_restore -U vertigo -d vertigo_harness --clean --if-exists < <file>.dump
```

The server applies the migrations on start; they are idempotent, so a dump from an older revision restores
cleanly and is brought forward.

## After the move

Once the server serves the connector, stop the laptop agents so two endpoints never claim the same runtime:

```
launchctl bootout gui/$(id -u)/com.studiovertigo.harness
launchctl bootout gui/$(id -u)/com.studiovertigo.ngrok
rm ~/Library/LaunchAgents/com.studiovertigo.{harness,ngrok}.plist
```

## Credentials, one per seller

The registries in `config/` are mounted read-only into the container, so a credential change takes effect on the
next request with no rebuild and no restart. Run the command in a one-off container that mounts them writable:

```
cd /root/vertigo-os
docker compose -f deploy/docker-compose.yml run --rm --no-deps \
  -v /root/vertigo-os/config:/cfg --entrypoint node harness \
  src/cli/token.ts <list|mint|rotate|revoke> [principal] \
  --file /cfg/http-tokens.local.json --principals /cfg/principals.local.json
```

`mint` and `rotate` print the raw token once, on stdout. It is stored nowhere: the registry keeps only its
SHA-256. A rotation revokes the previous token in the same write, so there is no window in which both work.

**Where the token goes.** ChatGPT offers OAuth or no authentication, and cannot present a static API key, so the
credential travels as the `/mcp/<token>` path segment. That URL therefore *is* the seller's credential: never
share it, and build one plugin archive per person. `HARNESS_ALLOW_PATH_TOKEN=false` turns the fallback off the
day the endpoint speaks OAuth; the endpoint then serves the `Authorization: Bearer` header only.

**If a token leaks**, rotate it and put the new URL in that person's application. That is the whole remediation.

## Secret hygiene (PT-IMG-001)

**The image carries no secret.** `.dockerignore` keeps `config/`, `.run/`, every `*.local*` file and every env
file out of the build context, and the Dockerfile has no `COPY config/`. The registries reach the container only
through the read-only mount in `docker-compose.yml`; the Notion token and the database password only through
compose's environment. Check a built image, without the mount:

```
cd /root/vertigo-os
docker build -f deploy/Dockerfile -t vertigo-harness-hygiene .
docker run --rm --entrypoint sh vertigo-harness-hygiene \
  -c 'ls -a /app/config 2>&1; find / -xdev \( -name "*.local*" -o -name ".env" \) 2>/dev/null'
docker image rm vertigo-harness-hygiene
```

`/app/config` must not exist and the `find` must print nothing.

**No log line carries a credential.** The access line redacts the `/mcp/<token>` segment and credential-bearing
query values (PT-SEC-001), the start line prints only non-secret attestations, and each `tool=` line prints the
tool name and its closed status and code, never an input, a handle, an id or a token.

**The Notion integration is shared only on the roots it must read.** In Notion, connect the integration to:

1. the META spec root named by `VERTIGO_META_SPEC_ROOT`;
2. each seller's OS root listed in `config/runtime-state/sales-runtimes.local.json`, and nothing above it.

Never connect it at the workspace or teamspace level. To audit, open the integration's page in Notion's
settings (Connections) and compare its page list with the two items above; remove anything else. A seller
added later is connected at the moment their runtime is registered, not before.
