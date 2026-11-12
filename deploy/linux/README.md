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

## Bildbaserade undertexter (OCR av PGS)

StreamVault använder verktyget PgsToSrt tillsammans med Tesseract för att göra om
bildbaserade undertexter (Blu-ray/PGS) till text. På Linux körs verktyget via `dotnet`.

Installera systempaketen (testat på Ubuntu 26.04; andra distributioner kan ha andra
paketnamn och versioner):

```bash
sudo apt install dotnet-runtime-10.0 libtesseract5 libleptonica6 unzip
```

- `unzip` behövs när StreamVault packar upp verktyget.
- Själva verktyget (PgsToSrt) och språkdata för Tesseract laddar StreamVault ner själv:
  gå till Inställningar och tryck på "Installera nu" i kortet för bildbaserade undertexter.
  Saknas något systempaket visar kortet i stället exakt vilket `apt`-kommando du ska köra.
- PgsToSrt är byggt för .NET 8, som inte finns i Ubuntu 26.04. StreamVault startar det därför
  med `DOTNET_ROLL_FORWARD=Major` (bara för just det programmet) så att det kör på .NET 10.
- Servern hittar Tesseract- och Leptonica-versionerna själv med `ldconfig -p`.

## HDR-filmer (tone mapping på grafikkortet)

4K HDR-filmer som omkodas för webbläsare färgmappas till SDR på grafikkortet med `libplacebo`
(via Vulkan), så att färgerna inte blir urblekta. Det kräver NVIDIA/NVENC, ett ffmpeg med
`libplacebo` och fungerande Vulkan (`/usr/share/vulkan/icd.d/nvidia_icd.json`). Servern testar
detta en gång vid start och loggar en rad (`[HDR] …`) om det inte går; då används den vanliga
omkodningen. Stäng av med `"hdr_tonemap": "off"` i `config.json` (standard är `"auto"`).

## Kända begränsningar på Linux

- **Mappbevakningen upptäcker inte nya filer på nätverksmonteringar (CIFS/NFS).** Linux
  skickar inga ändringsnotiser för filer som läggs till på andra datorer. Starta då en
  skanning för hand från StreamVaults inställningar när du lagt till filer. Lokala diskar
  bevakas som vanligt. Om gränsen för antal bevakade filer (inotify) nås loggar servern ett
  meddelande med bibliotekets namn och fortsätter köra.
- **Bildbaserade undertexter (PGS, OCR)** kräver några systempaket (se nästa avsnitt). Saknas
  de hoppas de spåren över med ett meddelande i loggen. Textundertexter fungerar alltid.
- **Automatisk uppdatering** finns inte på Linux (den hämtar en Windows-installerare).
  Uppdatera manuellt.
- **AMD (AMF)** används bara på Windows. Hårdvarukodning på Linux testas bara med NVIDIA/NVENC.
