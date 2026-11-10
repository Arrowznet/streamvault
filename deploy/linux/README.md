# StreamVault på Linux (test)

Det här är ett test av grenen `linux-port`, inget färdigt Linux-paket. Windows-versionen
påverkas inte av något här.

## Krav

- **Node.js 20 eller nyare.** Mappbevakningen använder `fs.watch` med `recursive: true`, som
  fungerar på Linux från Node 20.
- **ffmpeg och ffprobe** ska finnas i `PATH` (kontrollera med `ffmpeg -version` och
  `ffprobe -version`). För NVIDIA-kodning (NVENC) behövs ett ffmpeg som är byggt med NVENC/CUDA
  och NVIDIA-drivrutinen (`nvidia-smi` ska fungera).

## Starta

```bash
cd app
npm install --production
cd ..
node app/server/index.js
```

Öppna sedan `http://<serverns-adress>:7000`. Första gången hamnar du på `/setup` där du skapar
administratörskontot.

## Var sparas data? (`STREAMVAULT_DATA`)

Som standard sparas config, databaser och cache i `app/data/`. Sätt miljövariabeln
`STREAMVAULT_DATA` om de ska ligga någon annanstans. Servern lägger då allt i en undermapp
som heter `data`:

```bash
STREAMVAULT_DATA=/var/lib/streamvault node app/server/index.js
# => /var/lib/streamvault/data/config.json, databaser, loggar, hls/ och dash/
```

Mappen måste vara skrivbar för användaren som kör servern. Saknas `config.json` skapas den
automatiskt med standardvärden (port 7000 och en slumpad nyckel).

## Kör som tjänst

Se `streamvault.service` i den här mappen (ett systemd-exempel, bara som dokumentation).

## Kända begränsningar på Linux

- **Mappbevakningen upptäcker inte nya filer på nätverksmonteringar (CIFS/NFS).** Linux
  skickar inga ändringsnotiser för filer som läggs till på andra datorer. Starta då en
  skanning för hand från StreamVaults inställningar när du lagt till filer. Lokala diskar
  bevakas som vanligt. Om gränsen för antal bevakade filer (inotify) nås loggar servern ett
  meddelande med bibliotekets namn och fortsätter köra.
- **Bildbaserade undertexter (PGS, OCR)** stöds inte ännu: de spåren hoppas över med ett
  meddelande i loggen. Textundertexter fungerar.
- **Automatisk uppdatering** finns inte på Linux (den hämtar en Windows-installerare).
  Uppdatera manuellt.
- **AMD (AMF)** används bara på Windows. Hårdvarukodning på Linux testas bara med NVIDIA/NVENC.
